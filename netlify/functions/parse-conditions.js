// netlify/functions/parse-conditions.js
//
// Takes a base64 photo from the app's Vault Conditions scanner — a
// doctor's note, discharge summary, or handwritten/printed list of
// diagnoses — and asks Claude to read it and return a list of medical
// condition names found. Requires ANTHROPIC_API_KEY set as an
// environment variable in the Netlify site settings (Site configuration
// > Environment variables). Never hardcode the key here or ship it in
// the frontend bundle.
//
// Extracted names are NEVER auto-saved by the frontend — the app always
// shows a checklist review screen (every item pre-checked, editable,
// removable) that the caregiver must explicitly confirm before any
// condition is added to the Vault. This function only reads and lists;
// it does not decide.

const MAX_CONDITIONS = 30; // sane cap against a runaway/garbled read

const SYSTEM_PROMPT = `You read photos of medical documents — a doctor's note, a hospital discharge summary, an after-visit summary, or a handwritten/printed list of diagnoses or health conditions — and return ONLY a JSON array, no other text, no markdown fences.

Return a JSON array of objects, one per distinct medical condition or diagnosis found. Each object has exactly these fields:
{
  "name": string (the condition name in clear, plain language a non-clinician caregiver would recognize, e.g. "High blood pressure" rather than only "Hypertension, essential" if both appear; keep clinically accurate but prefer the common term when the document uses a lay term or an obvious clinical synonym exists),
  "confidence": "high" or "low" (low if the image is blurry, cropped, or you had to guess at the reading for this specific item)
}

Guidance:
- List each distinct condition only once, even if it is mentioned more than once in the document.
- Do not include medications, allergies, procedures, appointments, provider names, or dates as if they were conditions — only actual diagnoses or health conditions.
- Do not include vague administrative text (e.g. "follow up in 3 months", "see attached") as a condition.
- If a condition is qualified (e.g. "controlled", "in remission", "history of"), keep that qualifier in the name if it changes the clinical meaning, e.g. "Type 2 diabetes (well-controlled)" or "History of stroke".
- If you cannot confidently identify any conditions in the photo, return an empty array: []

Respond with the JSON array and nothing else.`;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('parse-conditions: ANTHROPIC_API_KEY is not set in the Netlify environment');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { imageBase64, mediaType } = payload;
  if (!imageBase64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing imageBase64' }) };
  }

  const allowedMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const resolvedMediaType = allowedMediaTypes.includes(mediaType) ? mediaType : 'image/jpeg';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: resolvedMediaType,
                  data: imageBase64,
                },
              },
              {
                type: 'text',
                text: 'Read this medical document and return the JSON array of conditions described in your instructions.',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('parse-conditions: Anthropic API error', response.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not read the document' }) };
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'No response from model' }) };
    }

    let parsed;
    try {
      const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('parse-conditions: could not parse model output', textBlock.text);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse condition data' }) };
    }

    const rawList = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);

    const seen = new Set();
    const conditions = rawList.slice(0, MAX_CONDITIONS).map((item) => {
      const it = item || {};
      return {
        name: typeof it.name === 'string' ? it.name.slice(0, 100) : '',
        confidence: it.confidence === 'low' ? 'low' : 'high',
      };
    }).filter((c) => {
      if (!c.name) return false;
      const key = c.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ conditions }),
    };
  } catch (err) {
    console.error('parse-conditions: unexpected error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected server error' }) };
  }
};
