// netlify/functions/check-privacy-status.js
//
// Public status-lookup endpoint. Requires BOTH a reference number
// (the row's own UUID, unguessable) AND the matching email -- neither
// alone is a safe lookup key, since email alone would let anyone check
// whether a given person had filed a deletion/withdrawal request.
// Always returns the same generic "not found" shape on any mismatch,
// so a wrong guess never reveals which of the two fields was wrong.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = { statusCode: 200, body: JSON.stringify({ found: false }) };

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return [];
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return NOT_FOUND;
  }

  const referenceId = (body.referenceId || '').trim();
  const email = (body.email || '').trim().toLowerCase();

  if (!UUID_RE.test(referenceId) || !email) {
    return NOT_FOUND;
  }

  const reqRows = await sb(`privacy_requests?id=eq.${referenceId}&select=id,request_type,status,email,submitted_at,due_date,resolved_at,resolution_notes`);
  const reqMatch = reqRows.find((r) => (r.email || '').toLowerCase() === email);
  if (reqMatch) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        found: true,
        kind: 'request',
        type: reqMatch.request_type,
        status: reqMatch.status,
        submitted_at: reqMatch.submitted_at,
        due_date: reqMatch.due_date,
        resolved_at: reqMatch.resolved_at,
        resolution_notes: reqMatch.resolution_notes,
      }),
    };
  }

  const appealRows = await sb(`privacy_appeals?id=eq.${referenceId}&select=id,status,email,submitted_at,due_date,resolved_at,resolution_notes`);
  const appealMatch = appealRows.find((r) => (r.email || '').toLowerCase() === email);
  if (appealMatch) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        found: true,
        kind: 'appeal',
        status: appealMatch.status,
        submitted_at: appealMatch.submitted_at,
        due_date: appealMatch.due_date,
        resolved_at: appealMatch.resolved_at,
        resolution_notes: appealMatch.resolution_notes,
      }),
    };
  }

  return NOT_FOUND;
};
