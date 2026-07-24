// netlify/functions/transcribe-note.js
//
// Takes a base64-encoded audio recording from the app's voice note feature.
// Two-step pipeline:
//   1. OpenAI Whisper turns the audio into a raw text transcript.
//   2. Claude turns that raw transcript into either a lightly cleaned
//      general note, or a structured After-Visit Note, depending on mode.
//
// Requires two environment variables in Netlify (Site configuration >
// Environment variables):
//   ANTHROPIC_API_KEY  - same key already used by parse-receipt.js
//   OPENAI_API_KEY     - new key, from platform.openai.com, used for Whisper
//
// Recording length: keep voice notes under about 2 minutes. Netlify functions
// have a request body size limit, and base64 encoding inflates audio size by
// roughly a third, so long recordings can hit that ceiling before they ever
// reach Whisper.
//
// Approximate cost per voice note (so there are no billing surprises):
//   Whisper transcription: about $0.006 per minute of audio
//     -> a 1-2 minute care note costs roughly half a cent to a penny
//   Claude cleanup/structuring: a few hundred tokens in, a few hundred out
//     -> a fraction of a cent per note on Sonnet
//   Rough total: well under 2 cents per voice note even on the high end.
//   At, say, 100 voice notes a month across a family, that's under $2/month
//   combined for both APIs. Cost scales with usage, not a flat monthly fee,
//   so it's worth a glance at the OpenAI and Anthropic usage dashboards after
//   the first few weeks of real family use, but nothing here should spike.

const AFTER_VISIT_SYSTEM_PROMPT = `You turn a caregiver's spoken, rambling voice note into a short, organized After-Visit Note. Return ONLY a JSON object, no other text, no markdown fences.

Return exactly these fields, all strings:
{
  "summary": "1-2 sentence overview of the visit",
  "mood": "how the parent/care recipient seemed emotionally and mentally",
  "meals": "anything mentioned about eating, drinking, or appetite",
  "medications": "anything mentioned about medications given, missed, or due",
  "concerns": "anything that sounded like a symptom, worry, or thing to watch",
  "followUp": "anything that sounds like an action item or something the next caregiver should do"
}

Rules:
- Only use what was actually said. Do not invent details.
- If a field was not mentioned at all, set it to "Not mentioned" rather than guessing.
- Keep each field to 1-2 short sentences, plain everyday language, no clinical jargon unless the caregiver used it themselves.
- Do not add em dashes anywhere in the text.`;

const GENERAL_SYSTEM_PROMPT = `You lightly clean up a raw voice-to-text transcript of a caregiver's note. Return ONLY a JSON object, no other text, no markdown fences.

Return exactly this field:
{
  "cleanedNote": "the cleaned up note text"
}

Rules:
- Remove filler words (um, uh, like, you know), false starts, and stutter repeats.
- Fix punctuation and capitalization so it reads as normal written sentences.
- Keep the caregiver's own words, meaning, and voice. Do not add information, do not summarize away detail, do not restructure into sections.
- Do not add em dashes anywhere in the text.`;

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

  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!openaiKey || !anthropicKey) {
    console.error('transcribe-note: missing OPENAI_API_KEY or ANTHROPIC_API_KEY in Netlify environment');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { audioBase64, mimeType, mode } = payload;
  if (!audioBase64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing audioBase64' }) };
  }
  const resolvedMode = mode === 'after-visit' ? 'after-visit' : 'general';
  const resolvedMimeType = mimeType || 'audio/webm';

  // ---- Step 1: transcribe with Whisper ----
  let transcript;
  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const extension = resolvedMimeType.includes('mp4') || resolvedMimeType.includes('m4a')
      ? 'm4a'
      : resolvedMimeType.includes('wav')
      ? 'wav'
      : 'webm';

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: resolvedMimeType }), `note.${extension}`);
    form.append('model', 'whisper-1');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      console.error('transcribe-note: Whisper API error', whisperRes.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not transcribe audio' }) };
    }

    const whisperData = await whisperRes.json();
    transcript = (whisperData.text || '').trim();
    if (!transcript) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'No speech detected in recording' }) };
    }
  } catch (err) {
    console.error('transcribe-note: unexpected transcription error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Unexpected error during transcription' }) };
  }

  // ---- Step 2: clean up or structure with Claude ----
  try {
    const systemPrompt = resolvedMode === 'after-visit' ? AFTER_VISIT_SYSTEM_PROMPT : GENERAL_SYSTEM_PROMPT;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Raw transcript:\n\n${transcript}` },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('transcribe-note: Anthropic API error', claudeRes.status, errText);
      // Fail soft: still return the raw transcript so the caregiver isn't left with nothing.
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ mode: resolvedMode, rawTranscript: transcript, note: null, cleanupFailed: true }),
      };
    }

    const claudeData = await claudeRes.json();
    const textBlock = (claudeData.content || []).find((b) => b.type === 'text');
    let note = null;
    if (textBlock) {
      try {
        const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
        note = JSON.parse(cleaned);
      } catch (err) {
        console.error('transcribe-note: could not parse Claude output', textBlock.text);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        mode: resolvedMode,
        rawTranscript: transcript,
        note,
        cleanupFailed: !note,
      }),
    };
  } catch (err) {
    console.error('transcribe-note: unexpected cleanup error', err);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ mode: resolvedMode, rawTranscript: transcript, note: null, cleanupFailed: true }),
    };
  }
};
