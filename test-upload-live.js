#!/usr/bin/env node
// Live end-to-end tests: really uploads short clips to the signed-in channel and
// verifies the result through the Data API (playlist membership, order, privacy,
// titles). Uses a unique marker per run so it never touches other content.
//
//   node test-upload-live.js                        # ~12 uploads, 25-40 minutes
//   LIVE_STAMP=myrun node test-upload-live.js
//   LIVE_RESUME=1 LIVE_STAMP=<same> node test-upload-live.js
//
// Resume skips whatever the per-tree ledgers already recorded, so an interrupted
// run continues instead of uploading again. Every ytup invocation is logged to
// <root>/runs/NN.log.
//
// A JSON report with every created playlist and video id is written to
// /tmp/opencode/ytup-live-<stamp>.json; cleanup-live-tests.js can remove them.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yt = require('./ytplaylists');

const REPO = __dirname;
const RESUME = process.env.LIVE_RESUME === '1';
const STAMP =
  process.env.LIVE_STAMP || new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12);
const P = `LIVE${STAMP}`;
const CLIP = process.env.LIVE_CLIP || '/tmp/opencode/test-video-2.mp4';
const ROOT = `/tmp/opencode/ytup-live-${STAMP}`;
const REPORT = `/tmp/opencode/ytup-live-${STAMP}.json`;

if (!yt.configured()) {
  console.error('needs client_secret.json and token.json (run node yt-oauth.js)');
  process.exit(1);
}
if (!fs.existsSync(CLIP)) {
  console.error(`test clip not found: ${CLIP}`);
  process.exit(1);
}

const startedAt = new Date();
const report = {
  stamp: STAMP,
  prefix: P,
  resume: RESUME,
  startedAt: startedAt.toISOString(),
  root: ROOT,
  scenarios: [],
  playlists: [],
  videos: [],
};
const failures = [];
let runCounter = 0;

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
const copy = (to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(CLIP, to);
};
const ledgerFile = (root) => path.join(root, '.youtube-upload-log.json');
const ledgerOf = (root) =>
  fs.existsSync(ledgerFile(root))
    ? JSON.parse(fs.readFileSync(ledgerFile(root), 'utf8')).records
    : [];
const ledgerCount = (root) => ledgerOf(root).length;

function run(args, { timeout = 20 * 60 * 1000 } = {}) {
  log('run  ytup', args.join(' '));
  const result = spawnSync(process.execPath, [path.join(REPO, 'ytup.js'), ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  const logFile = path.join(ROOT, 'runs', `${String(++runCounter).padStart(2, '0')}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `$ node ytup.js ${args.join(' ')}\n\n${out}\n`);

  if (result.error) throw new Error(`spawn failed: ${result.error.message} (${logFile})`);
  if (result.status !== 0) {
    throw new Error(`exit ${result.status} (${logFile})\n${out.split('\n').slice(-20).join('\n')}`);
  }
  return out;
}

const linksIn = (out) => [...out.matchAll(/uploaded: (https?:\/\/\S+)/g)].map((m) => m[1]);
const idOf = (link) => (link.match(/(?:youtu\.be\/|v=)([\w-]{6,})/) || [])[1];

async function playlistByTitle(title) {
  return (await yt.listPlaylists()).find((entry) => entry.title === title) || null;
}
async function titlesOf(title) {
  const playlist = await playlistByTitle(title);
  if (!playlist) return null;
  return (await yt.listPlaylistItems(playlist.id)).map((item) => item.title);
}

async function scenario(name, fn) {
  const started = Date.now();
  const checks = [];
  const created = { playlists: [], videos: [] };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  try {
    await fn({ check, created });
    const entry = { name, ok: true, ms: Date.now() - started, checks, created };
    report.scenarios.push(entry);
    report.playlists.push(...created.playlists);
    report.videos.push(...created.videos);
    log(`PASS ${name} (${Math.round(entry.ms / 1000)}s, ${checks.length} checks)`);
  } catch (error) {
    report.scenarios.push({
      name,
      ok: false,
      ms: Date.now() - started,
      checks,
      created,
      error: error.message,
    });
    report.playlists.push(...created.playlists);
    report.videos.push(...created.videos);
    failures.push(name);
    log(`FAIL ${name}: ${error.message.split('\n')[0]}`);
  }
}

async function remember(created, titles, videoIds) {
  for (const title of titles) {
    const playlist = await playlistByTitle(title);
    if (playlist) created.playlists.push({ id: playlist.id, title });
  }
  for (const id of [...new Set(videoIds.filter(Boolean))]) created.videos.push({ id });
}

async function main() {
  for (const file of ['SingletonLock', 'SingletonSocket', 'DevToolsActivePort']) {
    fs.rmSync(path.join(REPO, 'yt-profile', file), { force: true });
  }
  fs.mkdirSync(ROOT, { recursive: true });
  log(`prefix ${P}${RESUME ? ' (resume)' : ''}`);
  log(`unlisted test clips; report: ${REPORT}`);

  // 1 — depth 1: leaf playlists, roll-up, prefixes, root-level ignore, order.
  await scenario('depth 1 leaf playlists, roll-up, prefixes, root ignore', async ({ check, created }) => {
    const root = path.join(ROOT, 's1');
    for (const file of ['A/01-one.mp4', 'A/02-two.mp4', 'A/Sub/03-deep.mp4', 'B/01-three.mp4', 'loose.mp4']) {
      copy(path.join(root, file));
    }
    const before = ledgerCount(root);
    const out = run(['--playlist-depth', '1', '--playlist-prefix', `${P} `, '--title-prefix', `${P} `, root]);
    const after = ledgerOf(root);
    check(after.length === 4, `ledger has 4 records (${after.length})`);
    if (before < 4) {
      check(
        out.includes(`done: ${4 - before}/`),
        `uploaded the ${4 - before} pending file(s) (${out.match(/done: .*/)?.[0] || 'no summary'})`
      );
    } else {
      check(out.includes('nothing to upload'), 'resume skipped all four');
    }
    check(!out.includes('loose'), 'root-level loose.mp4 was ignored');

    const a = await titlesOf(`${P} A`);
    check(Array.isArray(a) && a.length === 3, `playlist A has 3 videos (got ${a?.length})`);
    check(
      JSON.stringify(a) === JSON.stringify([`${P} 01-one`, `${P} 02-two`, `${P} 03-deep`]),
      `playlist A order: ${JSON.stringify(a)}`
    );
    const b = await titlesOf(`${P} B`);
    check(Array.isArray(b) && b.length === 1 && b[0] === `${P} 01-three`, `playlist B has only 01-three`);
    const playlistA = await playlistByTitle(`${P} A`);
    check(playlistA.privacy === 'unlisted', `playlist A privacy ${playlistA.privacy}`);

    report.s1 = {
      video01one: after.find((record) => record.title === `${P} 01-one`)?.videoId,
      links: after.map((record) => record.link),
    };
    await remember(created, [`${P} A`, `${P} B`], after.map((record) => record.videoId));
  });

  // 2 — depth 2 + path naming: parent and child playlists, deepest assignment.
  await scenario('depth 2 path playlists, deepest assignment', async ({ check, created }) => {
    const root = path.join(ROOT, 's2');
    for (const file of ['Math/algebra.mp4', 'Math/Geometry/circles.mp4', 'Physics/motion.mp4']) {
      copy(path.join(root, file));
    }
    const pending = 3 - ledgerCount(root);
    const out = run([
      '--playlist-depth', '2',
      '--playlist-name', 'path',
      '--playlist-prefix', `${P}2 `,
      '--title-prefix', `${P} `,
      root,
    ]);
    if (pending > 0) {
      check(
        out.includes(`done: ${pending}/`),
        `uploaded ${pending} pending (${out.match(/done: .*/)?.[0] || 'no summary'})`
      );
    } else {
      check(out.includes('nothing to upload'), 'resume uploaded nothing');
    }
    check(ledgerCount(root) === 3, `ledger has 3 records (${ledgerCount(root)})`);

    const math = await titlesOf(`${P}2 Math`);
    const geometry = await titlesOf(`${P}2 Math / Geometry`);
    const physics = await titlesOf(`${P}2 Physics`);
    check(JSON.stringify(math) === JSON.stringify([`${P} algebra`]), `Math: ${JSON.stringify(math)}`);
    check(
      JSON.stringify(geometry) === JSON.stringify([`${P} circles`]),
      `Math / Geometry: ${JSON.stringify(geometry)}`
    );
    check(JSON.stringify(physics) === JSON.stringify([`${P} motion`]), `Physics: ${JSON.stringify(physics)}`);
    check(!math.includes(`${P} circles`), 'circles.mp4 was not duplicated into Math');

    report.s2 = { links: ledgerOf(root).map((record) => record.link) };
    await remember(
      created,
      [`${P}2 Math`, `${P}2 Math / Geometry`, `${P}2 Physics`],
      ledgerOf(root).map((record) => record.videoId)
    );
  });

  // 3 — depth 0: flat upload, no playlists.
  await scenario('depth 0 uploads flat without playlists', async ({ check, created }) => {
    const root = path.join(ROOT, 's3');
    copy(path.join(root, 'Flat/clipA.mp4'));
    const pending = 1 - ledgerCount(root);
    const out = run(['--playlist-depth', '0', '--title-prefix', `${P} `, root]);
    if (pending > 0) {
      check(out.includes('done: 1/1'), `uploaded 1/1 (${out.match(/done: .*/)?.[0] || 'no summary'})`);
    } else {
      check(out.includes('nothing to upload'), 'resume uploaded nothing');
    }
    const existing = (await yt.listPlaylists()).filter((entry) => entry.title.startsWith(`${P}0`));
    check(existing.length === 0, `no playlist was created (${existing.map((e) => e.title).join(', ')})`);
    report.s3 = { links: ledgerOf(root).map((record) => record.link) };
    await remember(created, [], ledgerOf(root).map((record) => record.videoId));
  });

  // 4 — playlist-mode off: folder grouping must not reach Studio's picker.
  await scenario('playlist mode off leaves videos out of playlists', async ({ check, created }) => {
    const root = path.join(ROOT, 's4');
    copy(path.join(root, 'Group/single.mp4'));
    let out = '';
    if (ledgerCount(root) === 0) {
      out = run([
        '--playlist-depth', '1',
        '--playlist-mode', 'off',
        '--playlist-prefix', `${P}off `,
        '--title-prefix', `${P} `,
        root,
      ]);
      check(out.includes('done: 1/1'), `uploaded 1/1 (${out.match(/done: .*/)?.[0] || 'no summary'})`);
      check(!out.includes('playlist "'), 'no playlist add was reported');
    } else {
      check(ledgerCount(root) === 1, 'existing ledger has one upload');
    }
    const playlist = await playlistByTitle(`${P}off Group`);
    check(playlist === null, 'no playlist was created for the folder');
    report.s4 = { links: ledgerOf(root).map((record) => record.link) };
    await remember(created, [], ledgerOf(root).map((record) => record.videoId));
  });

  // 5 — delete-on-success, then skip, then --no-skip.
  await scenario('delete-on-success, skip on rerun, --no-skip re-upload', async ({ check, created }) => {
    const root = path.join(ROOT, 's5');
    const file = path.join(root, 'Del/clipd.mp4');
    const args = [
      '--playlist-depth', '1',
      '--delete-on-success',
      '--playlist-prefix', `${P}d `,
      '--title-prefix', `${P} `,
      root,
    ];
    const records = ledgerCount(root);

    if (records === 0) {
      copy(file);
      const first = run(args);
      check(first.includes('done: 1/1'), 'first run uploaded');
      check(!fs.existsSync(file), 'file deleted after upload');
      check(ledgerOf(root).length === 1, 'one ledger record after upload');
      check((await titlesOf(`${P}d Del`))?.length === 1, 'playlist has the first video');
    }

    if (records <= 1) {
      copy(file);
      const second = run(args);
      check(second.includes('skipped: 1'), `second run skipped (${second.match(/skipped: \d+/)?.[0]})`);
      check(fs.existsSync(file), 'skipped file was not deleted');
      check(ledgerOf(root).length === 1, 'ledger unchanged after skip');
      check(!second.includes('uploaded:'), 'no upload happened on the skip run');

      const third = run([...args, '--no-skip']);
      check(third.includes('done: 1/1'), '--no-skip uploaded again');
      check(!fs.existsSync(file), 'file deleted after the forced upload');
      check(ledgerOf(root).length === 2, 'two ledger records after --no-skip');
      check((await titlesOf(`${P}d Del`))?.length === 2, 'playlist has both uploads');
    } else {
      check(records === 2, `existing ledger has two uploads (${records})`);
      check((await titlesOf(`${P}d Del`))?.length === 2, 'playlist has both uploads');
    }

    report.s5 = { links: ledgerOf(root).map((record) => record.link) };
    await remember(created, [`${P}d Del`], ledgerOf(root).map((record) => record.videoId));
  });

  // 6 — sync adoption from a title that is already on the channel (no upload).
  await scenario('sync adopts an already uploaded video without uploading', async ({ check, created }) => {
    const root = path.join(ROOT, 's6');
    copy(path.join(root, 'Any/01-one.mp4'));
    if (ledgerCount(root) === 0) {
      const out = run([
        '--sync-only',
        '--playlist-depth', '1',
        '--playlist-prefix', `${P} `,
        '--title-prefix', `${P} `,
        root,
      ]);
      check(out.includes('adopted: 1'), `adopted 1 (${out.match(/adopted: \d+/)?.[0]})`);
      check(!out.includes('uploaded:'), 'nothing was uploaded');
    }
    const records = ledgerOf(root);
    check(records.length === 1, 'adoption written to the ledger');
    check(records[0].adoptedFromStudio === true, 'record marked as adopted');
    check(
      records[0].videoId === report.s1.video01one,
      `adopted the right video (${records[0].videoId} vs ${report.s1.video01one})`
    );

    const rerun = run([
      '--playlist-depth', '1',
      '--playlist-prefix', `${P} `,
      '--title-prefix', `${P} `,
      root,
    ]);
    check(rerun.includes('skipped: 1'), 'rerun skipped the adopted file');
    check(rerun.includes('nothing to upload'), 'rerun uploaded nothing');
    report.s6 = { records };
    await remember(created, [], [records[0].videoId]);
  });

  // 7 — legacy playlist-mode ui (alias for api): add to an existing playlist.
  await scenario('legacy ui mode (api alias) adds to an existing playlist', async ({ check, created }) => {
    const root = path.join(ROOT, 's7');
    copy(path.join(root, `${P} B`, 'ui-add.mp4'));
    const pending = 1 - ledgerCount(root);
    const out = run([
      '--playlist-depth', '1',
      '--playlist-mode', 'ui',
      '--title-prefix', `${P} `,
      root,
    ]);
    if (pending > 0) {
      check(out.includes('done: 1/1'), `uploaded 1/1 (${out.match(/done: .*/)?.[0] || 'no summary'})`);
    } else {
      check(out.includes('nothing to upload'), 'resume uploaded nothing');
    }
    const titles = await titlesOf(`${P} B`);
    check(
      Array.isArray(titles) && titles.includes(`${P} ui-add`),
      `existing playlist received ui-add: ${JSON.stringify(titles)}`
    );
    report.s7 = { links: ledgerOf(root).map((record) => record.link) };
    await remember(created, [], ledgerOf(root).map((record) => record.videoId));
  });

  // Final: every expected title is really on the channel, with the right count.
  await scenario('channel contains every uploaded title', async ({ check }) => {
    const videos = await yt.listChannelVideos();
    const counts = new Map();
    for (const video of videos) counts.set(video.title, (counts.get(video.title) || 0) + 1);
    const expected = [
      [`${P} 01-one`, 1],
      [`${P} 02-two`, 1],
      [`${P} 03-deep`, 1],
      [`${P} 01-three`, 1],
      [`${P} algebra`, 1],
      [`${P} circles`, 1],
      [`${P} motion`, 1],
      [`${P} clipA`, 1],
      [`${P} single`, 1],
      [`${P} clipd`, 2],
      [`${P} ui-add`, 1],
    ];
    for (const [title, count] of expected) {
      check(counts.get(title) === count, `"${title}" appears ${counts.get(title) || 0}x (expected ${count})`);
    }
    check(!counts.has(`${P} loose`), 'loose.mp4 never reached the channel');
  });

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  report.ok = failures.length === 0;
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

  console.log('');
  for (const entry of report.scenarios) {
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);
    if (!entry.ok) console.log(`      ${entry.error.split('\n')[0]}`);
  }
  console.log(
    `\n${report.scenarios.filter((s) => s.ok).length}/${report.scenarios.length} scenarios passed, ` +
      `${report.videos.length} video(s), ${report.playlists.length} playlist(s), ` +
      `${Math.round(report.durationMs / 60000)} min`
  );
  console.log(`report: ${REPORT}`);
  console.log(`cleanup: node cleanup-live-tests.js ${REPORT} --yes`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(`live tests aborted: ${error.stack || error.message}`);
  fs.writeFileSync(
    REPORT,
    `${JSON.stringify(
      { ...report, ok: false, aborted: error.message, finishedAt: new Date().toISOString() },
      null,
      2
    )}\n`
  );
  process.exit(1);
});
