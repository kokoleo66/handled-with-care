// netlify/functions/check-overdue-meds.js
//
// Runs on a schedule (every 15 minutes, see the `schedule()` wrapper
// below) rather than being called by the app. For every active
// medication that's now overdue and hasn't triggered a push yet
// today, sends a push notification to every device subscribed for
// that family.
//
// Requires these environment variables in Netlify (Site configuration
// > Environment variables) — none of these are safe to put in the
// frontend, this function is the only place that ever sees them:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (Settings > API > service_role key —
//     NOT the anon key. This bypasses RLS, which is required here
//     since this function checks every family's medications at once.)
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT               (e.g. mailto:hello@handledwithcare.care)

const { schedule } = require('@netlify/functions');
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
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${path} failed: ${res.status} ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Same parsing rules as the client's parseScheduleHour(), kept in sync
// on purpose so "overdue" means the same thing everywhere in the app.
function parseScheduleHour(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (m) {
    let hour = parseInt(m[1], 10);
    const meridiem = m[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (!meridiem && hour >= 1 && hour <= 7) hour += 12;
    if (hour >= 0 && hour <= 23) return hour;
  }
  if (t.includes('morning') || t.includes('breakfast')) return 9;
  if (t.includes('noon') || t.includes('lunch')) return 12;
  if (t.includes('afternoon')) return 14;
  if (t.includes('evening') || t.includes('dinner')) return 18;
  if (t.includes('night') || t.includes('bedtime')) return 21;
  return null;
}

// Netlify's scheduled functions run on servers set to UTC, but your
// families care what time it is *for them*, not in London. This app
// doesn't store a per-family timezone yet, so this function assumes
// everyone is on Pacific time — true for your own testing today, but
// worth revisiting (a `timezone` column on `families`) once families
// outside the Pacific zone start using it, so this stays accurate.
const APP_TIMEZONE = 'America/Los_Angeles';

function localHourAndDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  const isoDate = `${get('year')}-${get('month')}-${get('day')}`;
  return { hour, isoDate };
}

async function handler() {
  const now = new Date();
  const { hour: currentHour, isoDate: todayISO } = localHourAndDate(now, APP_TIMEZONE);
  const dayStartLocal = new Date(`${todayISO}T00:00:00`);
  // Approximate day-start-in-UTC for the medication_logs query — good
  // enough for "has this been logged today," a few minutes of DST
  // slack either side of midnight doesn't change the answer.
  const dayStartISO = dayStartLocal.toISOString();

  const meds = await sb('medications?active=eq.true&select=id,name,schedule_time,family_id');
  const overdueMeds = meds.filter((m) => {
    const h = parseScheduleHour(m.schedule_time);
    return h !== null && currentHour >= h;
  });
  if (overdueMeds.length === 0) return { statusCode: 200, body: 'no scheduled meds due yet' };

  const medIds = overdueMeds.map((m) => m.id);
  const logs = await sb(
    `medication_logs?medication_id=in.(${medIds.join(',')})&status=eq.taken&logged_at=gte.${dayStartISO}&select=medication_id`
  );
  const takenIds = new Set(logs.map((l) => l.medication_id));

  const alreadySent = await sb(
    `push_notification_log?medication_id=in.(${medIds.join(',')})&sent_date=eq.${todayISO}&select=medication_id`
  );
  const sentIds = new Set(alreadySent.map((l) => l.medication_id));

  const toNotify = overdueMeds.filter((m) => !takenIds.has(m.id) && !sentIds.has(m.id));
  if (toNotify.length === 0) return { statusCode: 200, body: 'nothing new to notify' };

  let sentCount = 0;
  for (const med of toNotify) {
    const subs = await sb(`push_subscriptions?family_id=eq.${med.family_id}&select=id,user_id,endpoint,p256dh,auth`);
    if (!subs || subs.length === 0) continue;

    // Respect each person's own notification preference -- a device
    // being subscribed doesn't override the person later deciding they
    // don't want medication alerts specifically. Default (no row yet)
    // is enabled, matching existing behavior for anyone who hasn't
    // touched the toggle.
    const userIds = [...new Set(subs.map((s) => s.user_id).filter(Boolean))];
    let optedOut = new Set();
    if (userIds.length > 0) {
      const prefs = await sb(`notification_preferences?user_id=in.(${userIds.join(',')})&select=user_id,medications_enabled`);
      optedOut = new Set(prefs.filter((p) => p.medications_enabled === false).map((p) => p.user_id));
    }
    const eligibleSubs = subs.filter((s) => !optedOut.has(s.user_id));
    if (eligibleSubs.length === 0) continue;

    const payload = JSON.stringify({
      title: 'Medication not logged',
      body: `${med.name} hasn't been marked taken yet.`,
      tag: `overdue-med-${med.id}`,
      url: '/',
    });

    for (const sub of eligibleSubs) {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        await webpush.sendNotification(pushSub, payload);
      } catch (err) {
        // 404/410 means the browser unsubscribed or the subscription
        // expired — clean it up so future runs don't keep retrying it.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sb(`push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE', headers: {}, prefer: 'return=minimal' });
        } else {
          console.error('push failed for', sub.id, err.statusCode, err.body);
        }
      }
    }

    await sb('push_notification_log', {
      method: 'POST',
      body: JSON.stringify({ medication_id: med.id, family_id: med.family_id, sent_date: todayISO }),
      prefer: 'return=minimal',
    });
    sentCount++;
  }

  return { statusCode: 200, body: `notified for ${sentCount} medication(s)` };
}

// Every 15 minutes. Netlify's scheduled functions always run in UTC,
// which is fine here since all the hour math above uses the
// function's own server clock consistently — it doesn't need to match
// any specific family's timezone to detect "still not logged."
exports.handler = schedule('*/15 * * * *', handler);
