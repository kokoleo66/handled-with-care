// netlify/functions/calendar-feed.js
//
// A read-only .ics feed of a family's appointments, subscribable from
// any calendar app (Google, Apple, Outlook) via "Add calendar by URL."
// One-way only -- changes made in the external calendar never sync
// back here, and this endpoint never accepts writes.
//
// Access is gated by a dedicated random token (families.calendar_feed_token),
// deliberately NOT the family's own internal family_id -- this endpoint is
// public and unauthenticated (calendar apps can't do a Supabase login), so
// whoever holds this URL can read that family's appointment titles,
// providers, and locations. The token can be regenerated from within the
// app at any time to revoke a previously shared link without touching the
// family's actual identity.
//
// Requires the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY already
// set up for the other scheduled functions.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return null;
  return res.json();
}

function toICSDate(dateStr) {
  return new Date(dateStr).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeICS(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

exports.handler = async (event) => {
  const token = event.queryStringParameters && event.queryStringParameters.token;
  if (!token) {
    return { statusCode: 400, body: 'Missing token' };
  }

  const families = await sb(`families?calendar_feed_token=eq.${token}&select=id,care_recipient_name`);
  if (!families || families.length === 0) {
    return { statusCode: 404, body: 'Not found' };
  }
  const family = families[0];

  const appts = await sb(`appointments?family_id=eq.${family.id}&select=id,title,provider,location,appointment_at,notes&order=appointment_at.asc`);

  const calName = family.care_recipient_name ? `${family.care_recipient_name}'s Care Calendar` : 'Handled with Care';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Handled with Care//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeICS(calName)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];

  (appts || []).forEach((a) => {
    const start = new Date(a.appointment_at);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // default 1-hour block; no duration field exists yet
    const descParts = [a.provider ? `Provider: ${a.provider}` : null, a.notes || null].filter(Boolean);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${a.id}@handledwithcare`,
      `DTSTAMP:${toICSDate(new Date().toISOString())}`,
      `DTSTART:${toICSDate(a.appointment_at)}`,
      `DTEND:${toICSDate(end.toISOString())}`,
      `SUMMARY:${escapeICS(a.title)}`,
      a.location ? `LOCATION:${escapeICS(a.location)}` : null,
      descParts.length ? `DESCRIPTION:${escapeICS(descParts.join(' — '))}` : null,
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="handled-with-care.ics"',
    },
    body: lines.filter(Boolean).join('\r\n'),
  };
};
