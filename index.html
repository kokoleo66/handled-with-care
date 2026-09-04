// netlify/functions/parse-medication.js
//
// Takes a base64 photo of a pill bottle label (or a written medication
// list) from the app's medication scanner and asks Claude to read it and
// return structured medication data. Requires ANTHROPIC_API_KEY set as an
// environment variable in the Netlify site settings (Site configuration >
// Environment variables). Never hardcode the key here or ship it in the
// frontend bundle.
//
// Extracted data is NEVER auto-saved by the frontend — the app always
// shows a confirmation screen ("The medicine is... the dose is... taken
// at... is this right?") before writing anything to the medications
// table. This function only reads and structures; it does not decide.

const SYSTEM_PROMPT = `You read photos of medication labels (pill bottles, blister packs, or a handwritten/printed medication list) and return ONLY a JSON object, no other text, no markdown fences.

Return exactly these fields:
{
  "name": string (the medication name as printed, including strength if shown, e.g. "Lisinopril 10mg"),
  "dosage": string (how much is taken per dose, e.g. "1 tablet", "2 capsules"; empty string if not shown),
  "schedule_time": string (when it's taken, in the label's own words, e.g. "8:00 AM", "twice daily", "with dinner"; empty string if not shown),
  "instructions": string (any special instructions printed on the label, e.g. "take with food", "do not crush"; empty string if none),
  "confidence": "high" or "low" (low if the image is blurry, cropped, or you had to guess at any field)
}

Reading carefully matters most for the medication name and dosage, since a caregiver may rely on this to give the right medicine:
- If a label shows multiple numbers (prescription number, NDC number, refill number, pharmacy phone number), do not confuse these with the dosage or strength. The strength is usually right next to the drug name (e.g. "500 MG", "10MG").
- If any field is unclear, illegible, or the photo does not appear to be a medication label at all, set confidence to "low" and make your best reasonable guess rather than leaving fields blank, except when you cannot tell what the medication is at all — in that case return name as an empty string and set confidence to "low".

Respond with the JSON object and nothing else.`;

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
    console.error('parse-medication: ANTHROPIC_API_KEY is not set in the Netlify environment');
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
        max_tokens: 300,
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
                text: 'Read this medication label and return the JSON object described in your instructions.',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('parse-medication: Anthropic API error', response.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not read medication label' }) };
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
      console.error('parse-medication: could not parse model output', textBlock.text);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse medication data' }) };
    }

    const name = typeof parsed.name === 'string' ? parsed.name.slice(0, 120) : '';
    const dosage = typeof parsed.dosage === 'string' ? parsed.dosage.slice(0, 80) : '';
    const schedule_time = typeof parsed.schedule_time === 'string' ? parsed.schedule_time.slice(0, 80) : '';
    const instructions = typeof parsed.instructions === 'string' ? parsed.instructions.slice(0, 200) : '';
    const confidence = parsed.confidence === 'low' ? 'low' : 'high';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ name, dosage, schedule_time, instructions, confidence }),
    };
  } catch (err) {
    console.error('parse-medication: unexpected error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected server error' }) };
  }
};
