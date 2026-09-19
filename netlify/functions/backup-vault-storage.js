// netlify/functions/backup-vault-storage.js
//
// Supabase's database backups (Database > Backups, Pro plan) do NOT
// cover Storage objects -- only metadata about them lives in the
// database. This function is what actually protects the real files:
// insurance cards, advance directives, and anything else families
// upload to the Vault, plus the optional medication reference photos
// (label/pill) added later.
//
// Runs once daily. Walks every file in each source bucket
// (recursively, since files are organized in per-family folders) and
// copies each one into a second, completely separate backup bucket
// that the app itself never reads from or writes to during normal
// use -- it exists purely as a backup target.
//
// This protects against accidental deletion or a bug in the app that
// wipes files. It does NOT protect against total loss of the Supabase
// project itself, since both buckets live in the same project. A
// fuller off-Supabase backup (e.g. to S3) is a reasonable future
// upgrade but introduces a new vendor and its own DPA, so it's
// deliberately out of scope for this first pass.
//
// Requires the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env
// vars already set up for check-overdue-meds.js -- nothing new to add.

const { schedule } = require('@netlify/functions');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Each entry is one source bucket backed up into its own dedicated
// backup bucket. Adding a new Storage feature later just means adding
// a pair here -- easy to forget, so it's listed in one obvious place
// rather than scattered.
const BUCKET_PAIRS = [
  { source: 'vault-documents', backup: 'vault-documents-backup' },
  { source: 'medication-photos', backup: 'medication-photos-backup' },
];

async function listFolder(sourceBucket, prefix) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${sourceBucket}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) {
    throw new Error(`Failed to list ${prefix || '(root)'} in ${sourceBucket}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Recursively walks every folder to build a flat list of full file
// paths. Supabase's list endpoint returns one level at a time; an
// entry with a null `id` is a folder, not a file.
async function listAllFiles(sourceBucket, prefix = '') {
  const entries = await listFolder(sourceBucket, prefix);
  let files = [];
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      const nested = await listAllFiles(sourceBucket, fullPath);
      files = files.concat(nested);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function copyFile(sourceBucket, backupBucket, path) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/copy`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketId: sourceBucket,
      sourceKey: path,
      destinationBucket: backupBucket,
      destinationKey: path,
    }),
  });
  return res.ok;
}

async function backupBucketPair(sourceBucket, backupBucket) {
  let files;
  try {
    files = await listAllFiles(sourceBucket, '');
  } catch (err) {
    console.error(`${sourceBucket} backup failed to list files:`, err.message);
    return { bucket: sourceBucket, copied: 0, failed: 0, total: 0, error: err.message };
  }

  if (files.length === 0) {
    return { bucket: sourceBucket, copied: 0, failed: 0, total: 0 };
  }

  let copied = 0;
  let failed = 0;
  for (const path of files) {
    const ok = await copyFile(sourceBucket, backupBucket, path);
    if (ok) copied++;
    else {
      failed++;
      console.error(`Failed to back up ${sourceBucket}:`, path);
    }
  }
  return { bucket: sourceBucket, copied, failed, total: files.length };
}

async function handler() {
  const results = [];
  for (const pair of BUCKET_PAIRS) {
    results.push(await backupBucketPair(pair.source, pair.backup));
  }
  const summary = results
    .map((r) => (r.error ? `${r.bucket}: failed to list (${r.error})` : `${r.bucket}: ${r.copied}/${r.total} copied${r.failed ? `, ${r.failed} failed` : ''}`))
    .join(' | ');
  console.log(summary);
  return { statusCode: 200, body: summary };
}

// Once a day at 8am UTC (midnight Pacific-ish), well clear of the
// overdue-meds function's own every-15-minutes schedule.
exports.handler = schedule('0 8 * * *', handler);
