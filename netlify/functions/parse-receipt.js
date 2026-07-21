// netlify/functions/parse-receipt.js
//
// This runs on Netlify's servers, not in the browser. That's the whole point:
// your Anthropic API key lives here as an environment variable and is never
// sent to anyone's phone.
//
// SETUP (one time):
// 1. In the Netlify dashboard: Site settings > Environment variables
//    Add a variable named ANTHROPIC_API_KEY with your real key
//    (get one at https://console.anthropic.com if you don't have one yet).
// 2. Commit this file at netlify/functions/parse-receipt.js in your repo.
//    Netlify auto-detects functions in that folder, no extra config needed
//    for most sites. If your site already has a netlify.toml with a custom
//    "functions" directory, put this file there instead.
// 3. Deploy. The front end already calls it at:
//    /.netlify/functions/parse-receipt
//
// COST NOTE: each receipt scan is one small API call. Claude Haiku is used
// here because it's fast and inexpensive for this kind of straightforward
// extraction task. If you find it struggling on messy handwritten receipts,
// swap 'claude-haiku-4-5-20251001' below for 'claude-sonnet-5' (more capable,
// costs a bit more per call).

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in Netlify site settings.' })
    };
  }

  let imageBase64, mediaType;
  try {
    const parsedBody = JSON.parse(event.body);
    imageBase64 = parsedBody.imageBase64;
    mediaType = parsedBody.mediaType || 'image/jpeg';
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!imageBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No image provided' }) };
  }

  const prompt = `Look at this receipt photo and extract these fields. Respond with ONLY raw JSON, no markdown code fences, no extra commentary, matching exactly this shape:
{
  "merchant": "store or provider name, or null if unreadable",
  "date": "date on the receipt as YYYY-MM-DD, or null if unreadable",
  "total": (the total amount as a plain number, no currency symbol, or null if unreadable),
  "category": (your best guess, one of: "Medical", "Pharmacy", "Home Modifications", "Supplies", "Travel/Mileage", "Other"),
  "confidence": (one of "high", "medium", "low", based on how legible the receipt was)
}`;

  try {
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: imageBase64 }
              },
              { type: 'text', text: prompt }
            ]
          }
        ]
      })
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, errText);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Could not read the receipt right now. Try again or enter it manually.' })
      };
    }

    const data = await anthropicResponse.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');

    if (!textBlock) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No readable response from the model' }) };
    }

    let parsed;
    try {
      // Strip accidental code fences just in case, then parse.
      const cleaned = textBlock.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Could not read that receipt clearly. Try a clearer, well-lit photo.' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    console.error('parse-receipt function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong reading the receipt.' }) };
  }
};
