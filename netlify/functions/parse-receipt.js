// netlify/functions/parse-receipt.js
//
// Takes a base64 receipt photo from the app's expense scanner and asks
// Claude to read it and return structured expense data. Requires
// ANTHROPIC_API_KEY set as an environment variable in the Netlify site
// settings (Site configuration > Environment variables). Never hardcode
// the key here or ship it in the frontend bundle.

const ALLOWED_CATEGORIES = [
  'Medical',
  'Pharmacy',
  'Home Modifications',
  'Supplies',
  'Travel/Mileage',
  'Other',
];

const SYSTEM_PROMPT = `You read caregiving-related receipts and return ONLY a JSON object, no other text, no markdown fences.

Return exactly these fields:
{
  "merchant": string (store or provider name, short, as printed on the receipt),
  "date": string (ISO format YYYY-MM-DD, use your best read of the receipt date),
  "total": number (the final total charged, not subtotal, no dollar sign),
  "category": one of ${JSON.stringify(ALLOWED_CATEGORIES)},
  "confidence": "high" or "low" (low if the image is blurry, cropped, or you had to guess at any field)
}

Category guidance:
- "Medical" for doctor visits, copays, clinics, hospitals, therapy.
- "Pharmacy" for prescriptions and drugstore purchases.
- "Home Modifications" for grab bars, ramps, safety rails, contractor work.
- "Supplies" for incontinence supplies, mobility aids, general caregiving purchases.
- "Travel/Mileage" for gas, parking, rideshare tied to care-related travel.
- "Other" if nothing above fits.

Reading the total carefully matters most:
- The total is the number next to a label like TOTAL, TOTAL PURCHASE, BALANCE DUE, or AMOUNT DUE, usually the last dollar amount before the payment method section.
- Receipts often have other multi-digit numbers nearby: authorization codes, terminal IDs, transaction numbers, phone numbers, member numbers, card reference numbers. These are NOT the total, even if they are close to it or larger. Do not merge digits from these with the total.
- If the receipt is creased, folded, or faded, read the total digit by digit rather than pattern-matching, and set confidence to "low" if there is any doubt about even one digit.

If you cannot read a field, make your best reasonable estimate and set confidence to "low" rather than leaving fields blank. Respond with the JSON object and nothing else.`;

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
    console.error('parse-receipt: ANTHROPIC_API_KEY is not set in the Netlify environment');
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
                text: 'Read this receipt and return the JSON object described in your instructions.',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('parse-receipt: Anthropic API error', response.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not read receipt' }) };
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
      console.error('parse-receipt: could not parse model output', textBlock.text);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse receipt data' }) };
    }

    const merchant = typeof parsed.merchant === 'string' ? parsed.merchant.slice(0, 80) : 'Unknown merchant';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : new Date().toISOString().slice(0, 10);
    const total = typeof parsed.total === 'number' && isFinite(parsed.total) ? Math.round(parsed.total * 100) / 100 : 0;
    const category = ALLOWED_CATEGORIES.includes(parsed.category) ? parsed.category : 'Other';
    const confidence = parsed.confidence === 'low' ? 'low' : 'high';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ merchant, date, total, category, confidence }),
    };
  } catch (err) {
    console.error('parse-receipt: unexpected error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected server error' }) };
  }
};
