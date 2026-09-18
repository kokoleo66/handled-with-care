// netlify/functions/send-daily-digest.js
//
// Runs once a day. Bundles the "someone did something" events --
// Journal notes, appointment/medication additions or edits, group
// chat activity -- into ONE push per person per day, instead of
// pinging separately for each. Deliberately skips anyone whose day
// had zero relevant activity; an empty digest is worse than no push.
//
// Same Pacific-time assumption as check-overdue-meds.js, for the same
// reason: no per-family timezone stored yet.

const { schedule } = require('@netlify/functions');
const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_TIMEZONE = 'America/Los_Angeles';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

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
  const todayISO = localDateParts(now, APP_TIMEZONE);
  const dayStartISO = new Date(`${todayISO}T00:00:00`).toISOString();

  const families = await sb('families?select=id');
  if (!families || families.length === 0) return { statusCode: 200, body: 'no families' };

  let digestsSent = 0;

  for (const family of families) {
    const [journalEntries, appts, meds, chatMsgs] = await Promise.all([
      sb(`journal_entries?family_id=eq.${family.id}&created_at=gte.${dayStartISO}&select=id`),
      sb(`appointments?family_id=eq.${family.id}&or=(created_at.gte.${dayStartISO},updated_at.gte.${dayStartISO})&select=id`),
      sb(`medications?family_id=eq.${family.id}&or=(created_at.gte.${dayStartISO},updated_at.gte.${dayStartISO})&select=id`),
      sb(`messages?family_id=eq.${family.id}&created_at=gte.${dayStartISO}&select=id`),
    ]);

    const counts = {
      notes: (journalEntries || []).length,
      appts: (appts || []).length,
      meds: (meds || []).length,
      chat: (chatMsgs || []).length,
    };
    const total = counts.notes + counts.appts + counts.meds + counts.chat;
    if (total === 0) continue;

    const parts = [];
    if (counts.notes) parts.push(`${counts.notes} new Journal note${counts.notes > 1 ? 's' : ''}`);
    if (counts.appts) parts.push(`${counts.appts} appointment${counts.appts > 1 ? 's' : ''} added/changed`);
    if (counts.meds) parts.push(`${counts.meds} medication${counts.meds > 1 ? 's' : ''} added/changed`);
    if (counts.chat) parts.push(`${counts.chat} new chat message${counts.chat > 1 ? 's' : ''}`);
    const bodyText = `Today: ${parts.join(', ')}.`;

    const members = await sb(`family_members?family_id=eq.${family.id}&select=user_id`);
    if (!members || members.length === 0) continue;

    for (const member of members) {
      const already = await sb(`digest_log?family_id=eq.${family.id}&user_id=eq.${member.user_id}&digest_date=eq.${todayISO}&select=id`);
      if (already && already.length > 0) continue;

      const prefs = await sb(`notification_preferences?user_id=eq.${member.user_id}&select=daily_digest_enabled`);
      const enabled = prefs.length === 0 || prefs[0].daily_digest_enabled !== false;
      if (!enabled) continue;

      const subs = await sb(`push_subscriptions?user_id=eq.${member.user_id}&select=id,endpoint,p256dh,auth`);
      if (!subs || subs.length === 0) continue;

      const payload = JSON.stringify({ title: "Today's Huddle activity", body: bodyText, tag: 'daily-digest', url: '/' });
      let sentAny = false;
      for (const sub of subs) {
        const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
        try {
          await webpush.sendNotification(pushSub, payload);
          sentAny = true;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await sb(`push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' });
          } else {
            console.error('Digest push failed for', sub.id, err.statusCode, err.body);
          }
        }
      }

      if (sentAny) {
        await sb('digest_log', { method: 'POST', body: JSON.stringify({ family_id: family.id, user_id: member.user_id, digest_date: todayISO }) });
        digestsSent++;
      }
    }
  }

  return { statusCode: 200, body: `sent ${digestsSent} digest(s)` };
}

// Once daily. 02:00 UTC lands around 6-7pm Pacific depending on DST.
exports.handler = schedule('0 2 * * *', handler);
