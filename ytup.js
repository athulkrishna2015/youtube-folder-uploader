#!/usr/bin/env node
// ytup — upload a folder tree to YouTube, one playlist per folder.
// Mirrors the conventions of telegram-upload (--playlist-depth, --sort, --skip, --dry-run).
const fs = require('fs');
const path = require('path');
const { loadConfig, buildPlan } = require('./tree-plan');
const {
  loadLedger,
  saveLedger,
  indexLedger,
  isUploaded,
  addRecord,
  recordKey,
  fileFingerprint,
} = require('./ledger');
// Loaded lazily so --dry-run works before `npx tsc -p .` has produced dist/.

const HELP = `Usage: ytup [OPTIONS] PATH...

  Upload videos from a folder tree to your own YouTube channel. Every folder
  level up to --playlist-depth becomes a playlist, uploads are resumable, and a
  local upload log prevents re-uploading files that were moved or deleted.

Paths:
  The first path may be a folder (its subfolders become playlists) or a file.
  Extra paths are always files and are uploaded without a playlist.

Options:
  --playlist-depth N        Folder levels that become playlists (1..N). Each
                            video goes to the deepest playlist that contains it;
                            deeper folders roll up to level N. 0 uploads flat. [1]
  --playlist-name MODE      leaf: folder name only | path: parents joined with
                            --playlist-separator [leaf]
  --playlist-separator TEXT Separator for --playlist-name path [" / "]
  --playlist-prefix TEXT    Prefix added to every playlist name [none]
  --title-prefix TEXT       Prefix added to every video title [none]
  --privacy VALUE           Video privacy: public | unlisted | private [unlisted]
  --playlist-privacy VALUE  Playlist privacy: public | unlisted | private
                            [unlisted]
  --playlist-mode MODE      api: create/verify playlists and add videos with the
                            YouTube Data API | ui: legacy alias for api | off: no
                            playlist handling | auto: api when client_secret.json
                            and token.json exist, otherwise off [auto]
  --sort [ORDER]            File order: name_asc | name_desc | mtime_asc |
                            mtime_desc | random [name_asc]
  --skip                    Skip files already in the upload log [default]
  --no-skip                 Upload again even if the log says it was uploaded
  --sync                    Compare the tree with the channel: adopt videos that
                            are already uploaded, report log entries that are no
                            longer on the channel
  --sync-only               Sync and exit without uploading
  --sync-pages N            Studio pages of 30 videos to read when the Data API
                            is unavailable [100]
  --upload-log-file FILE    Upload log path [<root>/.youtube-upload-log.json]
  --delete-on-success       Delete each local file after it uploads
  --dry-run                 Preview playlists, titles, skips and ignored files.
                            No browser, no API calls, no writes
  --headless                Run Chrome without a window [default]
  --headed                  Show the browser window
  --version                 Print the version
  --help                    Show this message

Environment:
  CHROME_PATH               Chrome/Chromium binary [/usr/bin/google-chrome-unstable]
`;

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help')) {
  console.log(HELP);
  process.exit(argv.length ? 0 : 1);
}
if (argv.includes('--version')) {
  console.log(require('./package.json').version);
  process.exit(0);
}

const opts = { paths: [] };
const takesValue = new Set([
  '--playlist-depth', '--playlist-name', '--playlist-prefix', '--title-prefix',
  '--privacy', '--playlist-privacy', '--upload-log-file', '--playlist-separator',
  '--playlist-mode', '--sync-pages',
]);

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--skip') opts.skip = true;
  else if (arg === '--no-skip') opts.skip = false;
  else if (arg === '--sync') opts.sync = true;
  else if (arg === '--sync-only') { opts.sync = true; opts.syncOnly = true; }
  else if (arg === '--delete-on-success') opts.deleteOnSuccess = true;
  else if (arg === '--dry-run') opts.dryRun = true;
  else if (arg === '--headless') opts.headless = true;
  else if (arg === '--headed') opts.headless = false;
  else if (arg === '--sort') {
    const next = argv[i + 1];
    opts.order = next && !next.startsWith('-') ? (i++, next) : 'name_asc';
  } else if (takesValue.has(arg)) {
    opts[arg.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  } else if (arg.startsWith('-')) {
    console.error(`unknown option: ${arg}`);
    process.exit(1);
  } else opts.paths.push(arg);
}

if (!opts.paths.length) {
  console.error('no input path given (see --help)');
  process.exit(1);
}

if (opts.headless === undefined) opts.headless = true;

const PROFILE_DIR = path.join(__dirname, 'yt-profile');

// A crashed or interrupted run can leave Chrome holding the profile and a dead
// DevTools port behind, which makes the next launch fail with ECONNREFUSED.
// Kill only Chrome processes that use this profile, then drop the lock files.
function cleanChromeProfile(reason = '') {
  const killed = [];
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      let cmdline;
      try {
        cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      } catch (_) {
        continue;
      }
      if (!cmdline.includes(PROFILE_DIR)) continue;
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
      } catch (_) {
        // Already gone.
      }
    }
  } catch (_) {
    // /proc is Linux-only; on other systems the lock files are still removed.
  }

  for (const name of ['SingletonLock', 'SingletonSocket', 'DevToolsActivePort']) {
    try {
      fs.rmSync(path.join(PROFILE_DIR, name), { force: true });
    } catch (_) {
      // Best effort.
    }
  }
  if (killed.length) {
    console.warn(`${reason}cleaned stale Chrome (${killed.join(', ')}) and the profile locks`);
  }
}

function installChromeCleanup() {
  process.on('exit', () => cleanChromeProfile());
  process.on('SIGINT', () => {
    cleanChromeProfile('interrupted: ');
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanChromeProfile('terminated: ');
    process.exit(143);
  });
  process.on('uncaughtException', (error) => {
    console.error(error && error.stack ? error.stack : error);
    cleanChromeProfile('after error: ');
    process.exit(1);
  });
}

async function main() {
  // Dry runs must not touch anything, including stale browser state.
  if (!opts.dryRun) {
    installChromeCleanup();
    cleanChromeProfile('startup: ');
  }

  // A single input folder is the root; extra arguments are individual files.
  const first = opts.paths[0];
  const rootIsDir = fs.statSync(first).isDirectory();
  const config = loadConfig(path.join(process.cwd(), 'upload.config.json'));

  // Skipping known uploads is the default: re-running a tree must never
  // duplicate videos. Use --no-skip (or "skipAlreadyUploaded": false) to force.
  if (opts.skip === undefined) opts.skip = config.skipAlreadyUploaded !== false;

  if (rootIsDir) config.root = path.resolve(first);
  else config.root = path.dirname(path.resolve(first));

  config.playlistDepth =
    opts.playlistDepth !== undefined ? Number(opts.playlistDepth) : rootIsDir ? config.playlistDepth : 0;
  if (opts.playlistName) config.playlistName = opts.playlistName;
  if (opts.playlistPrefix) config.playlistPrefix = opts.playlistPrefix;
  if (opts.titlePrefix) config.titlePrefix = opts.titlePrefix;
  if (opts.privacy) config.videoPrivacy = opts.privacy;
  if (opts.playlistPrivacy) config.playlistPrivacy = opts.playlistPrivacy;
  if (opts.order) config.order = opts.order;
  if (opts.playlistSeparator) config.playlistSeparator = opts.playlistSeparator;

  if (!['public', 'unlisted', 'private'].includes(config.videoPrivacy)) {
    console.error(`invalid --privacy: ${config.videoPrivacy}`);
    process.exit(1);
  }
  if (!['public', 'unlisted', 'private'].includes(config.playlistPrivacy)) {
    console.error(`invalid --playlist-privacy: ${config.playlistPrivacy}`);
    process.exit(1);
  }

  const ledgerPath = path.resolve(
    opts.uploadLogFile || path.join(config.root, config.ledger || '.youtube-upload-log.json')
  );
  const logEnabled = true;
  const ledger = logEnabled ? loadLedger(ledgerPath) : { version: 1, records: [] };
  const ledgerIndex = indexLedger(ledger, 'dest');
  const hashCache = new Map();

  const plan = rootIsDir
    ? (() => {
        const built = buildPlan(config);
        // Extra file arguments next to the root folder are uploaded flat.
        const extra = opts.paths.slice(1).map((p) => path.resolve(p));
        return extra.length ? { ...built, orphans: [...built.orphans, ...extra] } : built;
      })()
    : { playlists: [], orphans: opts.paths.map((p) => path.resolve(p)) };

  const groups = [
    ...plan.playlists.map((playlist) => ({ name: playlist.name, files: playlist.files, folder: playlist.folder })),
    ...(plan.orphans.length ? [{ name: null, files: plan.orphans, folder: config.root }] : []),
  ];

  // Keep the full file list: syncing compares everything on disk with the
  // channel, including files that the ledger will later skip.
  const allGroups = groups.map((group) => ({ ...group, files: [...group.files] }));

  const videoTitle = (file) =>
    `${config.titlePrefix}${path.basename(file, path.extname(file))}`.slice(0, 100);

  // Resolved before the dry run so the preview can name the playlist backend,
  // without calling it.
  const ytplaylists = require('./ytplaylists');
  let playlistMode = opts.playlistMode || 'auto';
  if (playlistMode === 'ui') {
    console.warn('playlist mode "ui" is a legacy alias: playlists are managed with the Data API.');
    playlistMode = 'api';
  }
  if (playlistMode === 'auto') {
    playlistMode = ytplaylists.configured() ? 'api' : 'off';
    if (playlistMode === 'off') {
      console.warn('playlists need OAuth (run: node yt-oauth.js); uploading without playlists');
    }
  }

  if (opts.sync) {
    const { fetchChannelVideos, reconcile } = require('./sync');
    console.log('syncing with YouTube Studio…');
    const videos = await fetchChannelVideos({
      headless: opts.headless,
      maxPages: Number(opts.syncPages) || 100,
    });
    const expected = [];
    for (const group of allGroups) {
      for (const file of group.files) {
        expected.push({ file, playlist: group.name || '', title: videoTitle(file) });
      }
    }
    const { adopted, missing } = reconcile({ videos, ledger, expected });

    // Adopted videos are added to the in-memory ledger even for a dry run so the
    // preview then reports them as skipped, exactly like the real run; only the
    // write is skipped.
    for (const item of adopted) {
      addRecord(ledger, item.file, config.root, {
        playlist: item.playlist,
        title: item.title,
        link: `https://youtu.be/${item.video.id}`,
        videoId: item.video.id,
        adoptedFromStudio: true,
      }, hashCache);
    }
    if (adopted.length && !opts.dryRun) saveLedger(ledgerPath, ledger);

    console.log(
      `channel: ${videos.length} video(s) | ${opts.dryRun ? 'would adopt' : 'adopted'}: ${adopted.length} | missing from channel: ${missing.length}`
    );
    for (const item of adopted) {
      console.log(
        `  ${opts.dryRun ? 'would adopt' : 'adopted'}: ${path.relative(config.root, item.file)} -> ${item.video.id}`
      );
    }
    for (const record of missing) {
      console.log(
        `  no longer on channel: ${record.title || record.relPath || record.name} (${record.link || record.videoId || '?'})`
      );
    }

    ledgerIndex.clear();
    for (const record of ledger.records) {
      const key = recordKey(record, 'dest');
      if (key) ledgerIndex.set(key, record);
      if (record.sha256) ledgerIndex.set(`sha256:${record.sha256}`, record);
    }
    if (opts.syncOnly) return;
  }

  let totalFiles = 0;
  let skipped = 0;
  let playlistCount = 0;
  const skippedFiles = [];

  for (const group of groups) {
    const pending = [];
    for (const file of group.files) {
      if (opts.skip && isUploaded(file, config.root, ledgerIndex, 'dest', group.name, hashCache)) {
        skipped++;
        skippedFiles.push({ file, playlist: group.name || '' });
      } else {
        pending.push(file);
      }
    }
    group.files = pending;
    if (group.name && pending.length) playlistCount++;
    totalFiles += pending.length;
  }

  // Videos on disk that the plan does not cover: root-level files while
  // orphanVideos is "skip", and anything filtered out by includeNested. Reported
  // instead of silently ignored.
  const plannedFiles = new Set(allGroups.flatMap((group) => group.files));
  const unplanned = rootIsDir
    ? buildPlan({ ...config, playlistDepth: 0 }).orphans.filter((file) => !plannedFiles.has(file))
    : [];
  const unplannedReason = (file) =>
    path.dirname(file) === config.root
      ? 'root-level video; set "orphanVideos": "upload" to include it'
      : `deeper than --playlist-depth ${config.playlistDepth} with includeNested false`;

  const modeLabel =
    {
      api: 'Data API',
      off: 'disabled',
    }[playlistMode] || playlistMode;

  const skipRecordFor = (file, playlist) => {
    const fp = fileFingerprint(file, config.root);
    return ledgerIndex.get(recordKey({ ...fp, playlist: playlist || '' }, 'dest'));
  };

  const printDryRun = () => {
    console.log(`root: ${config.root}`);
    console.log(`playlists: ${playlistCount} | videos: ${totalFiles} | skipped: ${skipped}`);
    console.log(
      `playlist mode: ${modeLabel} | video privacy: ${config.videoPrivacy} | playlist privacy: ${config.playlistPrivacy}`
    );
    if (playlistMode === 'api' && !ytplaylists.configured()) {
      console.warn('warning: playlist mode api needs client_secret.json and token.json — run: node yt-oauth.js');
    }

    for (const group of groups) {
      const skippedHere = skippedFiles.filter((entry) => entry.playlist === (group.name || ''));
      if (!group.files.length && !skippedHere.length) continue;
      const heading = group.name
        ? `${playlistMode === 'off' ? 'folder' : 'playlist'} "${group.name}"`
        : 'no playlist';
      console.log(`\n[${heading}] ${group.files.length} to upload, ${skippedHere.length} skipped`);
      if (group.name && playlistMode !== 'off') {
        console.log(
          `  playlist: ${
            playlistMode === 'api'
              ? `would create or reuse (${config.playlistPrivacy})`
              : modeLabel
          }`
        );
      }
      for (const file of group.files) {
        console.log(`  upload  ${path.relative(config.root, file)}  ->  "${videoTitle(file)}"`);
      }
      for (const entry of skippedHere) {
        const record = skipRecordFor(entry.file, entry.playlist);
        console.log(
          `  skip    ${path.relative(config.root, entry.file)}  (${record?.link || 'already uploaded'})`
        );
      }
    }

    if (unplanned.length) {
      console.log(`\nnot planned: ${unplanned.length} video(s) on disk would be ignored`);
      for (const file of unplanned) {
        console.log(`  ignore  ${path.relative(config.root, file)}  (${unplannedReason(file)})`);
      }
    }

    if (!totalFiles && !skipped) console.log('\nnothing to upload');
    console.log(`\nlog: ${ledgerPath} (not modified)`);
    console.log('dry run: nothing created, uploaded, deleted or written');
  };

  if (opts.dryRun) {
    printDryRun();
    return;
  }

  console.log(`root: ${config.root}`);
  console.log(`playlists: ${playlistCount} | videos: ${totalFiles} | skipped: ${skipped}`);
  if (unplanned.length) {
    console.warn(
      `warning: ${unplanned.length} video(s) on disk are not covered by the plan — run --dry-run to list them`
    );
  }
  for (const group of groups) {
    if (!group.files.length) continue;
    console.log(`\n[${group.name ? `playlist ${group.name}` : 'no playlist'}] ${group.files.length} video(s)`);
    for (const file of group.files) console.log(`  ${path.relative(config.root, file)}`);
  }

  // Playlists: create/verify them before uploading so the run fails early if the
  // API is misconfigured. The Studio playlist picker is unreliable across UI
  // revisions, so the Data API is the supported path for creating playlists.
  if (playlistMode === 'api' && !ytplaylists.configured()) {
    console.error('\nplaylist mode "api" needs client_secret.json and token.json — run: node yt-oauth.js');
    process.exit(1);
  }

  const playlistIds = new Map();
  if (playlistMode === 'api') {
    const needed = [...new Set(groups.filter((group) => group.name && group.files.length).map((group) => group.name))];
    if (needed.length) console.log('\nensuring playlists…');
    for (const name of needed) {
      try {
        const playlist = await ytplaylists.ensurePlaylist(name, config.playlistPrivacy);
        playlistIds.set(name, playlist.id);
        console.log(`  ${playlist.id}  ${playlist.privacy}  ${name}`);
      } catch (error) {
        console.error(`  playlist "${name}" failed: ${error.message}`);
      }
    }

    // Repair uploads from interrupted runs: the video exists and is in the log,
    // but the playlist add never happened.
    const unadded = ledger.records.filter(
      (record) => record.videoId && record.playlist && !record.playlistAddedAt && !record.adoptedFromStudio
    );
    for (const record of unadded) {
      try {
        let playlistId = playlistIds.get(record.playlist);
        if (!playlistId) {
          const playlist = await ytplaylists.ensurePlaylist(record.playlist, config.playlistPrivacy);
          playlistId = playlist.id;
          playlistIds.set(record.playlist, playlistId);
        }
        await ytplaylists.addVideoToPlaylist(playlistId, record.videoId);
        record.playlistAddedAt = new Date().toISOString();
        saveLedger(ledgerPath, ledger);
        console.log(`  repaired playlist "${record.playlist}" <- ${record.videoId}`);
      } catch (error) {
        console.warn(`  playlist repair failed for ${record.title || record.videoId}: ${error.message}`);
      }
    }
  }

  if (!totalFiles) {
    console.log('\nnothing to upload');
    return;
  }

  const videos = [];
  const videoPlaylists = new Map();
  for (const group of groups) {
    for (const file of group.files) {
      if (group.name) videoPlaylists.set(file, group.name);
      videos.push({
        path: file,
        title: videoTitle(file),
        description: config.description || '',
        publishType: config.videoPrivacy,
        isNotForKid: true,
        playlistPrivacy: config.playlistPrivacy,
        onSuccess: (link) => {
          console.log(`  uploaded: ${link}`);
          if (!logEnabled) return;
          addRecord(ledger, file, config.root, {
            playlist: group.name || '',
            link,
            title: videoTitle(file),
            videoId: (link.match(/(?:youtu\.be\/|v=)([\w-]{6,})/) || [])[1] || undefined,
          }, hashCache);
          saveLedger(ledgerPath, ledger);
          if (opts.deleteOnSuccess) {
            try {
              fs.unlinkSync(file);
              console.log(`  deleted: ${file}`);
            } catch (error) {
              console.warn(`  could not delete ${file}: ${error.message}`);
            }
          }
        },
      });
    }
  }

  const { upload } = require('./dist'); // eslint-disable-line global-require
  const links = await upload({ email: 'profile@localhost' }, videos, {
    headless: opts.headless,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-unstable',
    userDataDir: path.join(__dirname, 'yt-profile'),
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  console.log(`\ndone: ${links.length}/${videos.length}`);
  links.forEach((link, i) => console.log(`  ${videos[i].title}: ${link}`));

  if (playlistMode === 'api') {
    for (let i = 0; i < links.length; i++) {
      const video = videos[i];
      const link = String(links[i] || '');
      const playlistName = videoPlaylists.get(video?.path);
      if (!playlistName) continue;
      const playlistId = playlistIds.get(playlistName);
      const videoId = (link.match(/(?:youtu\.be\/|v=)([\w-]{6,})/) || [])[1];
      if (!playlistId || !videoId) {
        console.warn(`  playlist "${playlistName}": could not add ${video.title}`);
        continue;
      }
      try {
        await ytplaylists.addVideoToPlaylist(playlistId, videoId);
        const record = ledger.records.find((entry) => entry.link === link);
        if (record) {
          record.playlistAddedAt = new Date().toISOString();
          saveLedger(ledgerPath, ledger);
        }
        console.log(`  playlist "${playlistName}" <- ${videoId}`);
      } catch (error) {
        console.warn(`  playlist "${playlistName}" add failed for ${video.title}: ${error.message}`);
      }
    }
  }

  if (logEnabled) console.log(`log: ${ledgerPath}`);
}

main().catch((error) => {
  console.error(`failed: ${error?.message || error}`);
  process.exit(1);
});
