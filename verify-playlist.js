#!/usr/bin/env node
// Verify a playlist's contents via the Data API: node verify-playlist.js "YTTEST PLTest"
const fs = require('fs');
const { listPlaylists } = require('./ytplaylists');

(async () => {
  const title = process.argv[2];
  if (!title) {
    console.error('usage: node verify-playlist.js "<playlist title>"');
    process.exit(1);
  }
  const playlist = (await listPlaylists()).find((entry) => entry.title === title);
  if (!playlist) {
    console.error(`playlist not found: ${title}`);
    process.exit(1);
  }
  const token = JSON.parse(fs.readFileSync('token.json', 'utf8')).access_token;
  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${playlist.id}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || response.status);

  console.log(`${playlist.title} (${playlist.id}, ${playlist.privacy}) — ${payload.pageInfo.totalResults} item(s)`);
  for (const item of payload.items || []) {
    console.log(`  ${item.contentDetails.videoId}  ${item.snippet.title}`);
  }
})().catch((error) => {
  console.error(`verify failed: ${error.message}`);
  process.exit(1);
});
