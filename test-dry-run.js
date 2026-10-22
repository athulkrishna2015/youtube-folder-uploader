#!/usr/bin/env node
// Dry-run tests: the plan must be exact, and --dry-run must not touch the
// ledger, the API, the browser or dist/.
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = __dirname;
const tmpRoot = process.env.YTUP_TEST_DIR || '/tmp/opencode';
fs.mkdirSync(tmpRoot, { recursive: true });
const work = fs.mkdtempSync(path.join(tmpRoot, 'ytup-dry-'));

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

function run(args, { cwd = work, script = path.join(repo, 'ytup.js') } = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    out: `${result.stdout || ''}${result.stderr || ''}`,
    ms: Date.now() - started,
  };
}

function writeFile(file, content = 'aaaaaaaaaaaa') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function tree(name) {
  const root = path.join(work, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

// ---------------------------------------------------------------- test trees

const flat = tree('flat');
writeFile(path.join(flat, 'A/a1.mp4'));
writeFile(path.join(flat, 'A/a2.mp4'));
writeFile(path.join(flat, 'A/Sub/a3.mp4'));
writeFile(path.join(flat, 'B/b1.mp4'));
writeFile(path.join(flat, 'loose.mp4'));

const nested = tree('nested');
writeFile(path.join(nested, 'Math/algebra.mp4'));
writeFile(path.join(nested, 'Math/Geometry/circles.mp4'));
writeFile(path.join(nested, 'Physics/motion.mp4'));

// ------------------------------------------------------------------ the tests

test('dry run lists folders as playlists and per-file titles', () => {
  const result = run(['--dry-run', '--playlist-depth', '1', '--title-prefix', 'T ', flat]);
  assert.strictEqual(result.status, 0, result.out);
  assert.ok(result.out.includes('playlists: 2 | videos: 4 | skipped: 0'), result.out);
  assert.ok(result.out.includes('[playlist "A"] 3 to upload, 0 skipped'), result.out);
  assert.ok(result.out.includes('upload  A/a1.mp4  ->  "T a1"'), result.out);
  assert.ok(result.out.includes('upload  A/Sub/a3.mp4  ->  "T a3"'), result.out);
  assert.ok(result.out.includes('[playlist "B"] 1 to upload, 0 skipped'), result.out);
  assert.ok(result.out.includes('would create or reuse (unlisted)'), result.out);
});

test('dry run reports root-level videos it will not upload', () => {
  const result = run(['--dry-run', '--playlist-depth', '1', flat]);
  assert.ok(result.out.includes('not planned: 1 video(s) on disk would be ignored'), result.out);
  assert.ok(result.out.includes('ignore  loose.mp4'), result.out);
});

test('dry run creates no ledger and starts no browser', () => {
  const root = tree('fresh');
  writeFile(path.join(root, 'C/c1.mp4'));
  const before = fs.readdirSync(root);
  const result = run(['--dry-run', '--playlist-depth', '1', root]);
  assert.strictEqual(result.status, 0, result.out);
  assert.deepStrictEqual(fs.readdirSync(root), before, 'dry run wrote files into the tree');
  assert.ok(!fs.existsSync(path.join(root, '.youtube-upload-log.json')), 'dry run created a ledger');
  for (const noise of ['Uploading video', 'Account loaded', 'ensuring playlists', 'successfully uploaded']) {
    assert.ok(!result.out.includes(noise), `dry run attempted real work: ${noise}`);
  }
  assert.ok(result.ms < 20000, `dry run took ${result.ms}ms — it is doing real work`);
});

test('dry run marks known uploads as skipped with their link', () => {
  const root = tree('skip');
  writeFile(path.join(root, 'A/a1.mp4'));
  writeFile(path.join(root, 'A/a2.mp4'));
  fs.writeFileSync(
    path.join(root, '.youtube-upload-log.json'),
    `${JSON.stringify(
      {
        version: 1,
        records: [
          {
            relPath: 'A/a1.mp4',
            name: 'a1.mp4',
            size: 12,
            playlist: 'A',
            title: 'a1',
            link: 'https://youtu.be/abc123',
            videoId: 'abc123',
          },
        ],
      },
      null,
      2
    )}\n`
  );

  const ledgerPath = path.join(root, '.youtube-upload-log.json');
  const before = fs.readFileSync(ledgerPath);
  const mtimeBefore = fs.statSync(ledgerPath).mtimeMs;

  const result = run(['--dry-run', '--playlist-depth', '1', root]);
  assert.strictEqual(result.status, 0, result.out);
  assert.ok(result.out.includes('videos: 1 | skipped: 1'), result.out);
  assert.ok(result.out.includes('skip    A/a1.mp4  (https://youtu.be/abc123)'), result.out);
  assert.ok(result.out.includes('upload  A/a2.mp4'), result.out);
  assert.ok(result.out.includes('(not modified)'), result.out);

  assert.ok(before.equals(fs.readFileSync(ledgerPath)), 'dry run rewrote the ledger');
  assert.strictEqual(fs.statSync(ledgerPath).mtimeMs, mtimeBefore, 'dry run touched the ledger mtime');

  const forced = run(['--dry-run', '--no-skip', '--playlist-depth', '1', root]);
  assert.ok(forced.out.includes('videos: 2 | skipped: 0'), forced.out);
  assert.ok(forced.out.includes('upload  A/a1.mp4'), forced.out);
});

test('nested files go to their deepest playlist, once', () => {
  const result = run(['--dry-run', '--playlist-depth', '2', '--playlist-name', 'path', nested]);
  assert.strictEqual(result.status, 0, result.out);
  assert.ok(result.out.includes('[playlist "Math"] 1 to upload, 0 skipped'), result.out);
  assert.ok(result.out.includes('[playlist "Math / Geometry"] 1 to upload, 0 skipped'), result.out);
  assert.ok(result.out.includes('[playlist "Physics"] 1 to upload, 0 skipped'), result.out);
  assert.strictEqual((result.out.match(/upload  Math\/algebra\.mp4/g) || []).length, 1, result.out);
  assert.ok(!result.out.includes('not planned'), result.out);
});

test('leaf naming at depth 2 uses the folder name', () => {
  const result = run(['--dry-run', '--playlist-depth', '2', nested]);
  assert.ok(result.out.includes('[playlist "Geometry"] 1 to upload, 0 skipped'), result.out);
});

test('includeNested false reports deeper files as not planned', () => {
  const root = tree('no-roll');
  writeFile(path.join(root, 'Math/algebra.mp4'));
  writeFile(path.join(root, 'Math/Geometry/circles.mp4'));
  fs.writeFileSync(
    path.join(root, 'upload.config.json'),
    JSON.stringify({ includeNested: false, playlistDepth: 1 })
  );
  const rolledUp = run(['--dry-run', '--playlist-depth', '1', root], { cwd: root });
  assert.ok(rolledUp.out.includes('not planned: 1 video(s) on disk would be ignored'), rolledUp.out);
  assert.ok(rolledUp.out.includes('ignore  Math/Geometry/circles.mp4'), rolledUp.out);
  assert.ok(rolledUp.out.includes('deeper than --playlist-depth 1'), rolledUp.out);
});

test('depth 0 uploads everything without playlists', () => {
  const result = run(['--dry-run', '--playlist-depth', '0', flat]);
  assert.strictEqual(result.status, 0, result.out);
  assert.ok(result.out.includes('playlists: 0 | videos: 5 | skipped: 0'), result.out);
  assert.ok(result.out.includes('[no playlist] 5 to upload'), result.out);
  assert.ok(result.out.includes('playlist mode:'), result.out);
});

test('dry run works without a built dist/', () => {
  const sandbox = fs.mkdtempSync(path.join(tmpRoot, 'ytup-nodist-'));
  for (const file of ['ytup.js', 'tree-plan.js', 'ledger.js', 'ytplaylists.js']) {
    fs.copyFileSync(path.join(repo, file), path.join(sandbox, file));
  }
  assert.ok(!fs.existsSync(path.join(sandbox, 'dist')), 'sandbox unexpectedly has dist');
  const result = run(['--dry-run', '--playlist-depth', '1', flat], {
    cwd: sandbox,
    script: path.join(sandbox, 'ytup.js'),
  });
  assert.strictEqual(result.status, 0, result.out);
  assert.ok(!result.out.includes('Cannot find module'), result.out);
  assert.ok(result.out.includes('upload  A/a1.mp4'), result.out);
});

test('playlist backend is named from the available credentials', () => {
  const inRepo = run(['--dry-run', '--playlist-depth', '1', flat], { cwd: repo });
  const sandbox = fs.mkdtempSync(path.join(tmpRoot, 'ytup-nocreds-'));
  for (const file of ['ytup.js', 'tree-plan.js', 'ledger.js', 'ytplaylists.js']) {
    fs.copyFileSync(path.join(repo, file), path.join(sandbox, file));
  }
  const withoutCreds = run(['--dry-run', '--playlist-depth', '1', flat], {
    cwd: sandbox,
    script: path.join(sandbox, 'ytup.js'),
  });
  assert.ok(withoutCreds.out.includes('playlist mode: Studio picker (existing playlists only)'), withoutCreds.out);
  if (fs.existsSync(path.join(repo, 'client_secret.json')) && fs.existsSync(path.join(repo, 'token.json'))) {
    assert.ok(inRepo.out.includes('playlist mode: Data API'), inRepo.out);
  }
});

test('single file arguments are previewed without a playlist', () => {
  const result = run(['--dry-run', path.join(flat, 'A/a1.mp4'), path.join(flat, 'B/b1.mp4')]);
  assert.strictEqual(result.status, 0, result.out);
  assert.ok(result.out.includes('[no playlist] 2 to upload'), result.out);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`work dir kept for inspection: ${work}`);
  process.exit(1);
}
fs.rmSync(work, { recursive: true, force: true });
