// Minimal example for the youtube-videos-uploader library (this repo's dist/).
//
// Usage:
//   YT_EMAIL="you@gmail.com" YT_PASS="app-or-account-password" \
//   YT_RECOVERY="recovery@example.com" \
//   node upload-example.js ./myvideo.mp4 "My video title" "My description"
//
// Extra options (thumbnail, tags, playlist, privacy...) are described in README.md.

const { upload } = require('./dist');

const [file, title, description = ''] = process.argv.slice(2);

if (!file || !title) {
  console.error('usage: node upload-example.js <video-file> <title> [description]');
  process.exit(1);
}

const credentials = {
  email: process.env.YT_EMAIL,
  pass: process.env.YT_PASS,
  recoveryemail: process.env.YT_RECOVERY,
};

if (!credentials.email || !credentials.pass) {
  console.error('set YT_EMAIL and YT_PASS environment variables');
  process.exit(1);
}

const video = {
  path: file,
  title,
  description,
  publishType: 'unlisted',
  isNotForKid: true,
  onProgress: (p) => console.log('progress:', p),
};

upload(credentials, [video], { headless: false })
  .then((links) => console.log('uploaded:', links))
  .catch((err) => {
    console.error('upload failed:', err);
    process.exit(1);
  });
