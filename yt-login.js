// One-time interactive login: opens a visible Chromium window on a persistent profile.
// Sign in to the target Google account, then leave the window alone; this script
// detects the logged-in YouTube Studio session and closes the browser.
//
//   node yt-login.js
//
// The session is stored in ./yt-profile and reused by upload-test.js.

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const profileDir = path.join(__dirname, 'yt-profile');
fs.mkdirSync(profileDir, { recursive: true });

const WAIT_MS = 15 * 60 * 1000;

(async () => {
  // Use the system Chrome (158.x) instead of Puppeteer's bundled Chrome 103:
  // Google refuses sign-in from outdated/automation-flagged browsers.
  const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-unstable';

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME,
    userDataDir: profileDir,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=ChromeWhatsNewUI',
      // Must match the uploader's launch (puppeteer-real-browser defaults to
      // basic). A profile signed in with a different store cannot decrypt its
      // own cookies on the next run and silently appears logged out.
      '--password-store=basic',
      '--use-mock-keychain',
    ],
    defaultViewport: null,
  });

  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded' });

  console.log('Sign in to the Google account you want to upload with.');
  console.log(`Browser profile: ${profileDir}`);

  const deadline = Date.now() + WAIT_MS;
  let loggedIn = false;

  while (Date.now() < deadline) {
    try {
      const url = page.url();
      const avatar = await page.$('button#avatar-btn, ytcp-avatar, #avatar-btn');
      if (avatar && url.includes('studio.youtube.com')) {
        loggedIn = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }

  if (!loggedIn) {
    console.error('Timed out waiting for a signed-in YouTube Studio session.');
    await browser.close();
    process.exit(1);
  }

  // let cookie writes settle before shutting down
  await new Promise((r) => setTimeout(r, 4000));

  let who = 'unknown';
  try {
    const t = await page.title();
    who = t || who;
  } catch {}

  await browser.close();
  console.log('Logged in. Page title:', who);
  console.log('Profile saved. Run: node upload-test.js <video> "<title>" "<description>"');
})().catch((e) => {
  console.error('login helper failed:', e.message);
  process.exit(1);
});
