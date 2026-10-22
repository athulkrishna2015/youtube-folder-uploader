#!/usr/bin/env node
// One-time OAuth setup for playlist operations (create playlist, set privacy,
// add a video). Uploads still happen through the browser, so the API quota is
// only used for playlists.
//
// 1. Create an OAuth client (Desktop app) in Google Cloud Console and download
//    it as client_secret.json next to this file.
// 2. Enable "YouTube Data API v3" for that project.
// 3. Run: node yt-oauth.js
const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');

const DIR = __dirname;
const CLIENT_FILE = path.join(DIR, 'client_secret.json');
const TOKEN_FILE = path.join(DIR, 'token.json');
const PORT = 8788;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/youtube';

if (!fs.existsSync(CLIENT_FILE)) {
  console.error(`missing ${CLIENT_FILE}\n\nCreate an OAuth "Desktop app" client in Google Cloud Console,\nenable YouTube Data API v3, and save the JSON next to this script.`);
  process.exit(1);
}

const secret = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
const client = secret.installed || secret.web;
if (!client?.client_id) {
  console.error('client_secret.json has no client_id (expected an "installed" client)');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

console.log('Open this URL and approve access:\n\n' + authUrl + '\n');
if (!process.env.NO_BROWSER) exec(`xdg-open '${authUrl}'`);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, REDIRECT);
  if (url.pathname !== '/oauth2callback') {
    response.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error || !code) {
    response.writeHead(400, { 'content-type': 'text/plain' }).end(`authorization failed: ${error}`);
    server.close();
    return;
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(JSON.stringify(tokens));

    fs.writeFileSync(
      TOKEN_FILE,
      `${JSON.stringify({ ...tokens, created_at: Date.now() }, null, 2)}\n`
    );
    response
      .writeHead(200, { 'content-type': 'text/plain' })
      .end('Authorized. You can close this window and return to the terminal.');
    console.log(`saved ${TOKEN_FILE}`);
  } catch (tokenError) {
    response.writeHead(500, { 'content-type': 'text/plain' }).end(String(tokenError));
    console.error(`token exchange failed: ${tokenError.message}`);
  } finally {
    server.close();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`waiting for the browser redirect on ${REDIRECT} …`);
});
