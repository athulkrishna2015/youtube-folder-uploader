#!/usr/bin/env node
// Read the channel's video list from YouTube Studio and reconcile it with the
// local upload log. Used by `ytup --sync` so a fresh checkout, or an edited
// upload log, does not re-upload videos that are already on the channel.
const path = require('path');
const puppeteer = require('puppeteer');

const PROFILE = path.join(__dirname, 'yt-profile');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-unstable';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function userAgentFor(version) {
  const major = String(version).replace('HeadlessChrome', 'Chrome').split('/')[1] || '120.0.0.0';
  const short = major.split('.').slice(0, 3).join('.');
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${short}.0 Safari/537.36`;
}

// Every video currently on the channel: [{ id, title, visibility }].
// Uses the Data API when OAuth is set up (fast, exact); otherwise scrapes Studio.
async function fetchChannelVideos({ headless = true, maxPages = 100 } = {}) {
  let ytplaylists = null;
  try {
    ytplaylists = require('./ytplaylists');
  } catch (_) {}

  if (ytplaylists?.configured()) {
    return ytplaylists.listChannelVideos();
  }

  const browser = await puppeteer.launch({
    headless,
    executablePath: CHROME,
    userDataDir: PROFILE,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1600,1000',
    ],
  });

  try {
    const page = (await browser.pages())[0];
    await page.setUserAgent(userAgentFor(await browser.version()));
    await page.setViewport({ width: 1600, height: 1000 });

    await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(6000);

    // Studio redirects to /channel/<id>/videos/upload; make sure we are there.
    if (!/\/channel\/[^/]+\/videos/.test(page.url())) {
      await page.goto('https://studio.youtube.com/channel/videos/upload', {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
      await sleep(5000);
    }

    const videos = [];
    const seen = new Set();

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      await page
        .waitForSelector('ytcp-video-row, ytcp-video-list-cell-video, #no-items-message', { timeout: 60000 })
        .catch(() => null);
      await sleep(1500);

      const rows = await page.evaluate(() => {
        const text = (element) => (element?.textContent || '').trim().replace(/\s+/g, ' ');
        return Array.from(document.querySelectorAll('ytcp-video-row')).map((row) => {
          const link = row.querySelector('a#video-title, a[href*="/video/"]');
          const href = link?.getAttribute('href') || '';
          const id = (href.match(/\/video\/([\w-]{6,})/) || [])[1] || null;
          const visibility =
            text(row.querySelector('#visibility')) ||
            text(row.querySelector('ytcp-video-row #visibility-text')) ||
            '';
          return { id, title: text(link) || text(row.querySelector('#video-title')), visibility };
        });
      });

      let added = 0;
      for (const row of rows) {
        if (!row.id || seen.has(row.id)) continue;
        seen.add(row.id);
        videos.push({ ...row, title: (row.title || '').trim() });
        added++;
      }

      const advanced = await page.evaluate(() => {
        const next =
          document.querySelector('#next-button button') ||
          document.querySelector('ytcp-button#next-button button') ||
          document.querySelector('[aria-label="Next"]');
        if (!next) return false;
        const disabled =
          next.disabled ||
          next.getAttribute('aria-disabled') === 'true' ||
          (next.closest('ytcp-button') || {}).hasAttribute?.('disabled');
        if (disabled) return false;
        next.click();
        return true;
      });

      if (!advanced || !rows.length || (added === 0 && pageNumber > 0)) break;
      await sleep(2500);
    }

    return videos;
  } finally {
    await browser.close().catch(() => {});
  }
}

function normalizeTitle(title) {
  return String(title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Reconcile ledger records with the channel list.
// - adopt: local videos whose title is on the channel but missing from the ledger
// - missing: ledger entries whose video is no longer on the channel
function reconcile({ videos, ledger, expected }) {
  const byTitle = new Map();
  for (const video of videos) {
    const key = normalizeTitle(video.title);
    if (!byTitle.has(key)) byTitle.set(key, video);
  }

  const adopted = [];
  for (const item of expected) {
    const match = byTitle.get(normalizeTitle(item.title));
    if (!match) continue;
    if (ledger.records.some((record) => record.videoId === match.id)) continue;
    adopted.push({ ...item, video: match });
  }

  const channelIds = new Set(videos.map((video) => video.id));
  const missing = ledger.records.filter((record) => {
    const id = record.videoId || (record.link || '').match(/(?:youtu\.be\/|v=)([\w-]{6,})/)?.[1];
    return id && !channelIds.has(id);
  });

  return { adopted, missing };
}

if (require.main === module) {
  fetchChannelVideos({ headless: !process.argv.includes('--headed') })
    .then((videos) => {
      console.log(`channel videos: ${videos.length}`);
      for (const video of videos) console.log(`  ${video.id}  ${video.visibility || '?'}  ${video.title}`);
    })
    .catch((error) => {
      console.error(`sync failed: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { fetchChannelVideos, reconcile, normalizeTitle };
