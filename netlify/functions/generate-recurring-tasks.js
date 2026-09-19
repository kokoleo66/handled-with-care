// netlify/functions/generate-recurring-tasks.js
//
// Runs once daily. For every active recurring_task_templates row due
// "today" (per its frequency rule), creates a real task instance in
// the tasks table -- if one doesn't already exist for that template
// on that date, so re-running this function never duplicates a task.
//
// This is the actual engine behind both standalone recurring tasks
// and named routines (Morning, Bedtime, Sunday Prep) -- a routine is
// just several templates sharing the same routine_id, generated
// together each day.
//
// Same Pacific-time assumption as the other scheduled functions, for
// the same reason: no per-family timezone stored yet.

const { schedule } = require('@netlify/functions');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_TIMEZONE = 'America/Los_Angeles';

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

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const isoDate = `${get('year')}-${get('month')}-${get('day')}`;
  const dayOfMonth = parseInt(get('day'), 10);
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[get('weekday')];
  return { isoDate, dayOfMonth, dayOfWeek };
}

function isDueToday(template, todayInfo) {
  if (template.frequency === 'daily') return true;
  const days = Array.isArray(template.recurrence_days) ? template.recurrence_days : [];
  if (template.frequency === 'weekly') return days.includes(todayInfo.dayOfWeek);
  if (template.frequency === 'monthly') return days.includes(todayInfo.dayOfMonth);
  if (template.frequency === 'custom') return days.includes(todayInfo.isoDate);
  return false;
}

async function handler() {
  const todayInfo = localDateParts(new Date(), APP_TIMEZONE);

  const templates = await sb('recurring_task_templates?active=eq.true&select=id,family_id,title,assigned_to,guide_id,frequency,recurrence_days');
  const dueTemplates = (templates || []).filter((t) => isDueToday(t, todayInfo));
  if (dueTemplates.length === 0) return { statusCode: 200, body: 'no templates due today' };

  const templateIds = dueTemplates.map((t) => t.id);
  const existing = await sb(
    `tasks?recurring_template_id=in.(${templateIds.join(',')})&due_date=eq.${todayInfo.isoDate}&select=recurring_template_id`
  );
  const alreadyGenerated = new Set((existing || []).map((t) => t.recurring_template_id));

  const toCreate = dueTemplates.filter((t) => !alreadyGenerated.has(t.id));
  if (toCreate.length === 0) return { statusCode: 200, body: "today's instances already exist" };

  let created = 0;
  for (const t of toCreate) {
    try {
      await sb('tasks', {
        method: 'POST',
        body: JSON.stringify({
          family_id: t.family_id,
          title: t.title,
          assigned_to: t.assigned_to,
          guide_id: t.guide_id,
          due_date: todayInfo.isoDate,
          status: 'open',
          recurring_template_id: t.id,
        }),
      });
      created++;
    } catch (err) {
      // Unique-index conflict means another run already created this
      // one between our check and this insert -- harmless, skip it.
      console.error('Could not create instance for template', t.id, err.message);
    }
  }

  return { statusCode: 200, body: `generated ${created} task instance(s)` };
}

// Once daily, ~5am Pacific (accounting for DST drift like the other functions).
exports.handler = schedule('0 12 * * *', handler);
