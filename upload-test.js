// Test upload that reuses the profile created by yt-login.js (no password in the script).
//
//   node upload-test.js /tmp/opencode/test-video.mp4 "Test upload" "Automated test"
//
// A browser window opens on the saved session; the library detects "Account already
// logged in" and goes straight to the upload page.

const path = require('path');
const { upload } = require('./dist');

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const [file, title, description = 'Test upload, safe to delete'] = args.filter((a) => a !== '--headless');

if (!file || !title) {
  console.error('usage: node upload-test.js [--headless] <video-file> <title> [description]');
  process.exit(1);
}

// Only used for cookie-file naming; the real auth comes from yt-profile.
const credentials = { email: 'profile@localhost' };

const video = {
  path: file,
  title,
  description,
  publishType: 'unlisted',
  isNotForKid: true,
  onProgress: (p) => console.log('progress:', p),
};

upload(credentials, [video], {
  headless,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-unstable',
  userDataDir: path.join(__dirname, 'yt-profile'),
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  defaultViewport: null,
})
  .then((links) => console.log('uploaded:', links))
  .catch((err) => {
    console.error('upload failed:', err?.message || err);
    process.exit(1);
  });
