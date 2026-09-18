// netlify/functions/check-appointment-reminders.js
//
// Runs every 15 minutes. Finds appointments starting within the next
// hour and sends a one-time push reminder to each family member who
// has appointment_reminder_enabled (default true) and a push
// subscription. appointment_reminder_log prevents re-sending the same
// reminder on the function's next run.

const { schedule } = require('@netlify/functions');
const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REMINDER_WINDOW_MS = 60 * 60 * 1000;

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

async function handler() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);

  const upcoming = await sb(
    `appointments?appointment_at=gte.${now.toISOString()}&appointment_at=lte.${windowEnd.toISOString()}&select=id,family_id,title,provider,appointment_at`
  );
  if (!upcoming || upcoming.length === 0) {
    return { statusCode: 200, body: 'no appointments in the reminder window' };
  }

  let sentCount = 0;
  for (const appt of upcoming) {
    const members = await sb(`family_members?family_id=eq.${appt.family_id}&select=user_id`);
    if (!members || members.length === 0) continue;

    for (const member of members) {
      const already = await sb(
        `appointment_reminder_log?appointment_id=eq.${appt.id}&user_id=eq.${member.user_id}&select=id`
      );
      if (already && already.length > 0) continue;

      const prefs = await sb(`notification_preferences?user_id=eq.${member.user_id}&select=appointment_reminder_enabled`);
      const enabled = prefs.length === 0 || prefs[0].appointment_reminder_enabled !== false;
      if (!enabled) continue;

      const subs = await sb(`push_subscriptions?user_id=eq.${member.user_id}&select=id,endpoint,p256dh,auth`);
      if (!subs || subs.length === 0) continue;

      const time = new Date(appt.appointment_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const payload = JSON.stringify({
        title: 'Upcoming appointment',
        body: `${appt.title}${appt.provider ? ' with ' + appt.provider : ''} at ${time}`,
        tag: `appt-reminder-${appt.id}`,
        url: '/',
      });

      for (const sub of subs) {
        const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
        try {
          await webpush.sendNotification(pushSub, payload);
          sentCount++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await sb(`push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' });
          } else {
            console.error('Reminder push failed for', sub.id, err.statusCode, err.body);
          }
        }
      }

      await sb('appointment_reminder_log', {
        method: 'POST',
        body: JSON.stringify({ appointment_id: appt.id, user_id: member.user_id }),
      });
    }
  }

  return { statusCode: 200, body: `sent ${sentCount} appointment reminder(s)` };
}

exports.handler = schedule('*/15 * * * *', handler);
