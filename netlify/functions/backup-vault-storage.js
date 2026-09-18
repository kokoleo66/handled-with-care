// netlify/functions/backup-vault-storage.js
//
// Supabase's database backups (Database > Backups, Pro plan) do NOT
// cover Storage objects -- only metadata about them lives in the
// database. This function is what actually protects the real files:
// insurance cards, advance directives, and anything else families
// upload to the Vault.
//
// Runs once daily. Walks every file in the vault-documents bucket
// (recursively, since files are organized in per-family folders) and
// copies each one into a second, completely separate bucket
// (vault-documents-backup) that the app itself never reads from or
// writes to during normal use -- it exists purely as a backup target.
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
const SOURCE_BUCKET = 'vault-documents';
const BACKUP_BUCKET = 'vault-documents-backup';

async function listFolder(prefix) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${SOURCE_BUCKET}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) {
    throw new Error(`Failed to list ${prefix || '(root)'}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Recursively walks every folder to build a flat list of full file
// paths. Supabase's list endpoint returns one level at a time; an
// entry with a null `id` is a folder, not a file.
async function listAllFiles(prefix = '') {
  const entries = await listFolder(prefix);
  let files = [];
  for (const entry of entries) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      const nested = await listAllFiles(fullPath);
      files = files.concat(nested);
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function copyFile(path) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/copy`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketId: SOURCE_BUCKET,
      sourceKey: path,
      destinationBucket: BACKUP_BUCKET,
      destinationKey: path,
    }),
  });
  return res.ok;
}

async function handler() {
  let files;
  try {
    files = await listAllFiles('');
  } catch (err) {
    console.error('Vault backup failed to list files:', err.message);
    return { statusCode: 500, body: `Failed to list files: ${err.message}` };
  }

  if (files.length === 0) {
    return { statusCode: 200, body: 'No Vault files to back up yet.' };
  }

  let copied = 0;
  let failed = 0;
  for (const path of files) {
    const ok = await copyFile(path);
    if (ok) copied++;
    else {
      failed++;
      console.error('Failed to back up:', path);
    }
  }

  const summary = `Vault backup: ${copied} file(s) copied, ${failed} failed, ${files.length} total.`;
  console.log(summary);
  return { statusCode: 200, body: summary };
}

// Once a day at 8am UTC (midnight Pacific-ish), well clear of the
// overdue-meds function's own every-15-minutes schedule.
exports.handler = schedule('0 8 * * *', handler);
