// Append-only upload ledger so interrupted runs can resume, and so files can be
// deleted from disk without ever being uploaded again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function emptyLedger() {
  return { version: 1, records: [] };
}

function loadLedger(file) {
  if (!fs.existsSync(file)) return emptyLedger();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.records)) return emptyLedger();
    return parsed;
  } catch {
    return emptyLedger();
  }
}

function saveLedger(file, ledger) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function fileFingerprint(file, root) {
  const stat = fs.statSync(file);
  return {
    relPath: path.relative(root, file).split(path.sep).join('/'),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

function recordKey(record, mode) {
  // Mirror telegram-upload's cache: destination + basename + size, so files can be
  // moved or deleted without ever being uploaded twice.
  if (mode === 'sha256') return record.sha256 ? `sha256:${record.sha256}` : null;
  if (mode === 'path') return record.relPath ? `path:${record.relPath}` : null;
  const name = record.relPath ? record.relPath.split('/').pop() : record.name;
  return `dest:${record.playlist || ''}:${name}:${record.size}`;
}

function indexLedger(ledger, mode) {
  const index = new Map();
  for (const record of ledger.records) {
    const key = recordKey(record, mode);
    if (key) index.set(key, record);
  }
  return index;
}

// A file counts as uploaded when its destination key (or content hash) is already known.
function isUploaded(file, root, ledgerIndex, mode, playlist, hashCache) {
  const fp = fileFingerprint(file, root);
  if (mode === 'sha256') {
    const digest = hashCache?.get(file) || sha256(file);
    hashCache?.set(file, digest);
    return ledgerIndex.has(`sha256:${digest}`);
  }
  return ledgerIndex.has(recordKey({ ...fp, playlist }, mode));
}

function addRecord(ledger, file, root, extra, hashCache) {
  const fp = fileFingerprint(file, root);
  const record = {
    ...fp,
    name: fp.relPath.split('/').pop(),
    sha256: hashCache?.get(file),
    uploadedAt: new Date().toISOString(),
    ...extra,
  };
  ledger.records.push(record);
  return record;
}

module.exports = { loadLedger, saveLedger, indexLedger, isUploaded, addRecord, sha256, fileFingerprint, recordKey };
