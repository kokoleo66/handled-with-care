// netlify/functions/submit-privacy-request.js
//
// Accepts a POST from the public privacy-request.html page. Regular
// rights requests (access/delete/withdraw_consent/other) go into
// privacy_requests. Appeals go into a separate privacy_appeals table
// with its own status vocabulary (open/under_review/upheld/overturned)
// and its own 45-day due date -- a real distinct thread, not just
// another row mixed in with first-time requests.
//
// Requires the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env
// vars already set up for check-overdue-meds.js -- nothing new to add.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_TYPES = ['access', 'delete', 'withdraw_consent', 'appeal', 'other'];

async function insertRow(table, payload) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const requestType = body.requestType;
  const details = (body.details || '').trim();

  if (!name || !email || !VALID_TYPES.includes(requestType)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid fields' }) };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email address' }) };
  }

  let res;
  if (requestType === 'appeal') {
    res = await insertRow('privacy_appeals', { name, email, reason: details || null });
  } else {
    res = await insertRow('privacy_requests', { name, email, request_type: requestType, details: details || null });
  }

  if (!res.ok) {
    const text = await res.text();
    console.error('Failed to insert privacy submission:', res.status, text);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong submitting your request. Please email nicole@genxcaregiver.care directly instead.' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
