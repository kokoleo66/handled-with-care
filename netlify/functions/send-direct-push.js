// netlify/functions/send-direct-push.js
//
// A generic, instant push sender called directly by the client right
// after a user action -- a direct message sent, a task assigned to
// someone. Unlike check-overdue-meds or the appointment-reminder
// function, this isn't scheduled; it fires the moment the triggering
// action happens, since there's already a live client session
// available to make the call. No preference check for these two
// event types deliberately -- a message or task assigned to you
// specifically isn't something that gets muted.
//
// Requires the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and
// the same VAPID_* env vars, already set up for check-overdue-meds.js.

const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=minimal',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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

  const { recipientUserId, title, notifBody, url, tag } = body;
  if (!recipientUserId || !title || !notifBody) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const subs = await sb(`push_subscriptions?user_id=eq.${recipientUserId}&select=id,endpoint,p256dh,auth`);
  if (!subs || subs.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0, reason: 'no subscriptions for this user' }) };
  }

  const payload = JSON.stringify({ title, body: notifBody, tag: tag || undefined, url: url || '/' });
  let sent = 0;
  for (const sub of subs) {
    const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(pushSub, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await sb(`push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' });
      } else {
        console.error('Push failed for', sub.id, err.statusCode, err.body);
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
};
