#!/usr/bin/env node
// Delete everything a test-upload-live.js run created.
//
//   node cleanup-live-tests.js /tmp/opencode/ytup-live-<stamp>.json
//   node cleanup-live-tests.js /tmp/opencode/ytup-live-<stamp>.json --yes
//
// Without --yes it only lists what would be deleted. Videos are removed first
// (which also drops them from playlists), then the playlists.
const fs = require('fs');
const yt = require('./ytplaylists');

const [reportPath, ...flags] = process.argv.slice(2);
const confirmed = flags.includes('--yes');

if (!reportPath) {
  console.error('usage: node cleanup-live-tests.js <report.json> [--yes]');
  process.exit(1);
}
if (!fs.existsSync(reportPath)) {
  console.error(`report not found: ${reportPath}`);
  process.exit(1);
}
if (!yt.configured()) {
  console.error('needs client_secret.json and token.json');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const videos = [...new Map(report.videos.map((entry) => [entry.id, entry])).values()];
const playlists = [...new Map(report.playlists.map((entry) => [entry.id, entry])).values()];

console.log(`run ${report.prefix || '?'} — ${videos.length} video(s), ${playlists.length} playlist(s)`);
for (const video of videos) console.log(`  video     ${video.id}  ${video.title || ''}`);
for (const playlist of playlists) console.log(`  playlist  ${playlist.id}  ${playlist.title}`);

if (!confirmed) {
  console.log('\nnothing deleted; re-run with --yes');
  process.exit(0);
}

(async () => {
  let deleted = 0;
  const failed = [];
  for (const video of videos) {
    try {
      await yt.deleteVideo(video.id);
      console.log(`deleted video   ${video.id}`);
      deleted++;
    } catch (error) {
      if (/not found|404/i.test(error.message)) {
        console.log(`already gone    ${video.id}`);
      } else {
        failed.push(`video ${video.id}: ${error.message}`);
      }
    }
  }
  for (const playlist of playlists) {
    try {
      await yt.deletePlaylist(playlist.id);
      console.log(`deleted playlist ${playlist.id}`);
      deleted++;
    } catch (error) {
      if (/not found|404/i.test(error.message)) {
        console.log(`already gone     ${playlist.id}`);
      } else {
        failed.push(`playlist ${playlist.id}: ${error.message}`);
      }
    }
  }

  console.log(`\n${deleted} item(s) deleted`);
  if (failed.length) {
    console.error(`${failed.length} failure(s):`);
    for (const message of failed) console.error(`  ${message}`);
    process.exit(1);
  }
})().catch((error) => {
  console.error(`cleanup failed: ${error.message}`);
  process.exit(1);
});
