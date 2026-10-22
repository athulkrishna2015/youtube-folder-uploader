#!/usr/bin/env node
// Unit tests for channel reconciliation and the ledger's path-independent keys.
const assert = require('assert');
const { reconcile, normalizeTitle } = require('./sync');
const { recordKey, indexLedger, isUploaded } = require('./ledger');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

const video = (id, title) => ({ id, title, visibility: 'unlisted' });
const record = (extra) => ({ name: 'a.mp4', size: 10, playlist: 'P', ...extra });

test('titles match across case and repeated whitespace', () => {
  assert.strictEqual(normalizeTitle('  My   Lecture 01 '), 'my lecture 01');
  const { adopted } = reconcile({
    videos: [video('v1', 'My Lecture 01')],
    ledger: { records: [] },
    expected: [{ file: '/x/a.mp4', playlist: 'P', title: 'my lecture   01' }],
  });
  assert.strictEqual(adopted.length, 1);
  assert.strictEqual(adopted[0].video.id, 'v1');
  assert.strictEqual(adopted[0].playlist, 'P');
});

test('already recorded videos are not adopted twice', () => {
  const { adopted } = reconcile({
    videos: [video('v1', 'Clip')],
    ledger: { records: [record({ videoId: 'v1' })] },
    expected: [{ file: '/x/a.mp4', playlist: 'P', title: 'Clip' }],
  });
  assert.strictEqual(adopted.length, 0);
});

test('missing titles are left for a real upload', () => {
  const { adopted } = reconcile({
    videos: [video('v1', 'Other')],
    ledger: { records: [] },
    expected: [{ file: '/x/a.mp4', playlist: 'P', title: 'Clip' }],
  });
  assert.strictEqual(adopted.length, 0);
});

test('the first channel match wins for duplicate titles', () => {
  const { adopted } = reconcile({
    videos: [video('v1', 'Clip'), video('v2', 'clip')],
    ledger: { records: [] },
    expected: [{ file: '/x/a.mp4', playlist: '', title: 'CLIP' }],
  });
  assert.strictEqual(adopted.length, 1);
  assert.strictEqual(adopted[0].video.id, 'v1');
});

test('ledger entries absent from the channel are reported', () => {
  const { missing } = reconcile({
    videos: [video('keep1', 'a'), video('keep2', 'b')],
    ledger: {
      records: [
        record({ videoId: 'gone1', title: 'gone' }),
        record({ videoId: 'keep1' }),
        // Older records may only carry a link.
        record({ link: 'https://youtu.be/gone2xxxxxxx' }),
        record({ videoId: undefined, link: '' }),
      ],
    },
    expected: [],
  });
  assert.deepStrictEqual(missing.map((entry) => entry.videoId || entry.link), [
    'gone1',
    'https://youtu.be/gone2xxxxxxx',
  ]);
});

test('the skip key ignores the folder path', () => {
  const left = recordKey(record({ relPath: 'Math/algebra.mp4' }));
  const right = recordKey(record({ relPath: 'Archive/2024/algebra.mp4' }));
  assert.strictEqual(left, right);
  assert.strictEqual(left, 'dest:P:algebra.mp4:10');
});

test('the skip key changes with playlist or size', () => {
  const base = recordKey(record({ relPath: 'A/algebra.mp4' }));
  assert.notStrictEqual(base, recordKey(record({ relPath: 'A/algebra.mp4', playlist: 'Q' })));
  assert.notStrictEqual(base, recordKey(record({ relPath: 'A/algebra.mp4', size: 11 })));
});

test('a moved file still counts as uploaded', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(process.env.YTUP_TEST_DIR || '/tmp/opencode', 'ytup-key-'));
  const before = path.join(dir, 'one', 'clip.mp4');
  const after = path.join(dir, 'two', 'clip.mp4');
  fs.mkdirSync(path.dirname(before), { recursive: true });
  fs.mkdirSync(path.dirname(after), { recursive: true });
  fs.writeFileSync(before, '0123456789');
  fs.writeFileSync(after, '0123456789');

  const ledger = { records: [record({ relPath: 'one/clip.mp4', playlist: 'P', size: 10 })] };
  const index = indexLedger(ledger, 'dest');
  assert.strictEqual(isUploaded(before, dir, index, 'dest', 'P'), true);
  assert.strictEqual(isUploaded(after, dir, index, 'dest', 'P'), true);
  assert.strictEqual(isUploaded(after, dir, index, 'dest', 'Other'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
