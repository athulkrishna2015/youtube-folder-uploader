// Folder -> playlist planning: pure filesystem logic, no browser.
const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.wmv']);

const DEFAULT_CONFIG = {
  root: '.',
  playlistDepth: 1,
  playlistName: 'leaf', // 'leaf' | 'path'
  playlistSeparator: ' / ',
  playlistPrefix: '',
  titlePrefix: '',
  videoPrivacy: 'unlisted',
  playlistPrivacy: 'unlisted',
  order: 'name_asc',
  includeNested: true,
  orphanVideos: 'skip', // 'skip' | 'upload' (videos not under any playlist folder)
  skipAlreadyUploaded: true,
  ledger: '.youtube-upload-log.json',
  videoExtensions: [...VIDEO_EXTENSIONS],
};

function loadConfig(configPath) {
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const config = { ...DEFAULT_CONFIG, ...raw };
  config.root = path.resolve(config.root);
  config.videoExtensions = new Set(config.videoExtensions.map((e) => e.toLowerCase()));
  return config;
}

function isVideo(file, config) {
  return config.videoExtensions.has(path.extname(file).toLowerCase());
}

function sortEntries(entries, order) {
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const list = [...entries];
  switch (order) {
    case 'name_desc':
      return list.sort((a, b) => byName(b, a));
    case 'mtime_asc':
      return list.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    case 'mtime_desc':
      return list.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    case 'random':
      return list.sort(() => Math.random() - 0.5);
    case 'name_asc':
    default:
      return list.sort(byName);
  }
}

function playlistFolders(root, depth) {
  // Every folder from level 1 through `depth` is a playlist; files are assigned
  // to the deepest one that contains them.
  const result = [];
  let level = [root];
  for (let i = 1; i <= depth; i++) {
    const next = [];
    for (const dir of level) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) next.push(path.join(dir, entry.name));
      }
    }
    result.push(...next);
    level = next;
  }
  return result.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function videosIn(dir, recursive, config) {
  const found = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
      } else if (isVideo(full, config)) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

function playlistLabel(folder, root, config) {
  const relative = path.relative(root, folder);
  const segments = relative.split(path.sep).filter(Boolean);
  const base = config.playlistName === 'path' ? segments.join(config.playlistSeparator) : segments[segments.length - 1];
  return `${config.playlistPrefix}${base}`;
}

function videoTitle(file, config) {
  const base = path.basename(file, path.extname(file));
  return `${config.titlePrefix}${base}`.slice(0, 100);
}

function buildPlan(config) {
  if (!fs.existsSync(config.root)) throw new Error(`root not found: ${config.root}`);

  // depth 0: no playlist split, everything is uploaded flat
  if (!config.playlistDepth) {
    const files = sortEntries(videosIn(config.root, true, config), config.order);
    return { playlists: [], orphans: files };
  }

  const folders = playlistFolders(config.root, config.playlistDepth);
  const byFolder = new Map(
    folders.map((folder) => [
      folder,
      { folder, name: playlistLabel(folder, config.root, config), files: [] },
    ])
  );

  // Assign each video to the deepest playlist folder at or above it. A folder
  // nested deeper than --playlist-depth rolls up to its shallowest ancestor that
  // is still inside the depth, so nothing is uploaded twice or dropped silently.
  const rootVideos = [];
  for (const file of sortEntries(videosIn(config.root, true, config), config.order)) {
    const segments = path.relative(config.root, file).split(path.sep);
    const levels = segments.length - 1;
    if (!levels) {
      rootVideos.push(file);
      continue;
    }
    if (levels > config.playlistDepth && !config.includeNested) continue;
    const target = path.join(config.root, ...segments.slice(0, Math.min(levels, config.playlistDepth)));
    byFolder.get(target)?.files.push(file);
  }

  const playlists = [...byFolder.values()];
  const orphans = config.orphanVideos === 'upload' ? rootVideos : [];

  return { playlists, orphans };
}

module.exports = { loadConfig, buildPlan, sortEntries, DEFAULT_CONFIG };
