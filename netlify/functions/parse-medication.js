// netlify/functions/parse-medication.js
//
// Takes a base64 photo from the app's medication scanner — a single pill
// bottle label, OR a typed/printed medication list (e.g. a discharge
// sheet or pharmacy printout listing several medications) — and asks
// Claude to read it and return structured medication data for EACH
// medication found. Requires ANTHROPIC_API_KEY set as an environment
// variable in the Netlify site settings (Site configuration >
// Environment variables). Never hardcode the key here or ship it in the
// frontend bundle.
//
// Always returns an array, even for a single bottle (array of length 1).
// Extracted data is NEVER auto-saved by the frontend — the app always
// shows a confirmation screen ("The medicine is... the dose is... taken
// at... is this right?") for EACH medication before writing anything to
// the medications table. This function only reads and structures; it
// does not decide.

const MAX_MEDICATIONS = 25; // sane cap against a runaway/garbled read

const SYSTEM_PROMPT = `You read photos of medication information — this may be a SINGLE pill bottle label, OR a TYPED/PRINTED LIST of several medications (e.g. a hospital discharge sheet or pharmacy printout) — and return ONLY a JSON array, no other text, no markdown fences.

Return a JSON array. Each element represents ONE medication, with exactly these fields:
{
  "name": string (the medication name as printed, including strength if shown, e.g. "Lisinopril 10mg"),
  "dosage": string (how much is taken per dose, e.g. "1 tablet", "2 capsules"; empty string if not shown),
  "schedule_time": string (when it's taken, in the label's own words, e.g. "8:00 AM", "twice daily", "with dinner"; empty string if not shown),
  "instructions": string (any special instructions printed on the label, e.g. "take with food", "do not crush"; empty string if none),
  "confidence": "high" or "low" (low if the image is blurry, cropped, or you had to guess at any field for this specific medication)
}

If the photo shows a single pill bottle, return an array with exactly one element.
If the photo shows a list with multiple medications (a discharge sheet, a printed med list, several bottles lined up), return one array element per distinct medication, in the order they appear on the page. Do not merge different medications into one entry, and do not split one medication's name and dosage across two entries.

Reading carefully matters most for each medication's name and dosage, since a caregiver may rely on this to give the right medicine:
- If a label or list shows other numbers (prescription number, NDC number, refill number, pharmacy phone number, patient ID), do not confuse these with a dosage or strength. The strength is usually right next to the drug name (e.g. "500 MG", "10MG").
- If any field for a given medication is unclear or illegible, set that medication's confidence to "low" and make your best reasonable guess rather than leaving fields blank.
- If the photo does not appear to show any medication information at all, return an empty array: []

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
        max_tokens: 2000,
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
                text: 'Read this photo (a single medication label, or a list of several medications) and return the JSON array described in your instructions.',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('parse-medication: Anthropic API error', response.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not read medication information' }) };
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

    const rawList = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);

    const medications = rawList.slice(0, MAX_MEDICATIONS).map((item) => {
      const it = item || {};
      return {
        name: typeof it.name === 'string' ? it.name.slice(0, 120) : '',
        dosage: typeof it.dosage === 'string' ? it.dosage.slice(0, 80) : '',
        schedule_time: typeof it.schedule_time === 'string' ? it.schedule_time.slice(0, 80) : '',
        instructions: typeof it.instructions === 'string' ? it.instructions.slice(0, 200) : '',
        confidence: it.confidence === 'low' ? 'low' : 'high',
      };
    }).filter((m) => m.name); // drop any entry with no name at all — nothing useful to confirm

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ medications }),
    };
  } catch (err) {
    console.error('parse-medication: unexpected error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected server error' }) };
  }
};
