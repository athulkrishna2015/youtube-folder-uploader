// Batch upload: upload every video in a folder (or an explicit list) sequentially.
//
//   node upload-batch.js [--headless] [--privacy unlisted] <dir-or-file> [more files...]
//
// Titles default to the file name (without extension); pass --title-prefix to prepend text.
// Videos are uploaded one at a time; the YouTube session comes from ./yt-profile, so no
// sign-in or API quota is involved.

const fs = require('fs');
const path = require('path');
const { upload } = require('./dist');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value ?? fallback;
};

const headless = argv.includes('--headless');
if (headless) argv.splice(argv.indexOf('--headless'), 1);

const privacy = flag('--privacy', 'unlisted');
const prefix = flag('--title-prefix', '');
const description = flag('--description', 'Uploaded with youtube-uploader');
const extensions = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const dryRun = argv.includes('--dry-run');
if (dryRun) argv.splice(argv.indexOf('--dry-run'), 1);

const inputs = argv;
if (!inputs.length) {
  console.error('usage: node upload-batch.js [--headless] [--privacy unlisted] [--dry-run] <dir-or-file> [...]');
  process.exit(1);
}

const files = [];
for (const input of inputs) {
  if (fs.statSync(input).isDirectory()) {
    for (const entry of fs.readdirSync(input)) {
      if (extensions.has(path.extname(entry).toLowerCase())) files.push(path.join(input, entry));
    }
  } else {
    files.push(input);
  }
}

if (!files.length) {
  console.error('no video files found');
  process.exit(1);
}

const videos = files.map((file) => ({
  path: path.resolve(file),
  title: `${prefix}${path.basename(file, path.extname(file))}`.slice(0, 100),
  description,
  publishType: privacy,
  isNotForKid: true,
  onSuccess: (link) => console.log(`  uploaded: ${link}`),
}));

console.log(`${files.length} video(s), privacy=${privacy}, headless=${headless}${dryRun ? ', dry run' : ''}`);
for (const v of videos) console.log(`  ${v.title} <- ${v.path}`);

if (dryRun) process.exit(0);

// Only used for cookie-file naming; auth comes from yt-profile.
const credentials = { email: 'profile@localhost' };

upload(credentials, videos, {
  headless,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-unstable',
  userDataDir: path.join(__dirname, 'yt-profile'),
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  defaultViewport: null,
})
  .then((links) => {
    console.log(`done: ${links.length}/${videos.length}`);
    links.forEach((l, i) => console.log(`  ${videos[i]?.title}: ${l}`));
  })
  .catch((err) => {
    console.error('batch failed:', err?.message || err);
    process.exit(1);
  });
