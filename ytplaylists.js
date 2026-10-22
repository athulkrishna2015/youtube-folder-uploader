// Playlist operations through the YouTube Data API.
//
// Why the API here: the Studio playlist UI cannot create a playlist with a known
// privacy setting (and breaks between UI revisions). Uploads stay in the browser,
// so the 6-per-day API upload limit does not apply — only playlists use quota
// (playlists.insert = 50 units, playlistItems.insert = 50 units).
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CLIENT_FILE = path.join(DIR, 'client_secret.json');
const TOKEN_FILE = path.join(DIR, 'token.json');
const API = 'https://www.googleapis.com/youtube/v3';

function configured() {
  return fs.existsSync(CLIENT_FILE) && fs.existsSync(TOKEN_FILE);
}

function loadClient() {
  const secret = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
  const client = secret.installed || secret.web;
  if (!client?.client_id) throw new Error('client_secret.json is not a Desktop OAuth client');
  return client;
}

let cached = null;

async function accessToken() {
  const client = loadClient();
  const token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  if (token.access_token && token.created_at && Date.now() - token.created_at < (token.expires_in - 60) * 1000) {
    return token.access_token;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const refreshed = await response.json();
  if (!response.ok) throw new Error(`token refresh failed: ${JSON.stringify(refreshed)}`);

  const merged = {
    ...token,
    ...refreshed,
    refresh_token: refreshed.refresh_token || token.refresh_token,
    created_at: Date.now(),
  };
  fs.writeFileSync(TOKEN_FILE, `${JSON.stringify(merged, null, 2)}\n`);
  return merged.access_token;
}

async function api(pathname, { method = 'GET', query = {}, body } = {}) {
  if (!cached) cached = { token: await accessToken(), videos: new Map(), playlists: new Map() };
  const url = new URL(`${API}/${pathname}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${cached.token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${payload.error?.message || response.status}`);
  }
  return payload;
}

async function listPlaylists() {
  const playlists = [];
  let pageToken;
  do {
    const page = await api('playlists', {
      query: { part: 'id,snippet,status', mine: 'true', maxResults: '50', pageToken },
    });
    for (const item of page.items || []) {
      playlists.push({
        id: item.id,
        title: item.snippet?.title || '',
        privacy: (item.status?.privacyStatus || '').toLowerCase(),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return playlists;
}

async function createPlaylist(title, privacy = 'unlisted') {
  const created = await api('playlists', {
    method: 'POST',
    query: { part: 'id,snippet,status' },
    body: {
      snippet: { title },
      status: { privacyStatus: privacy },
    },
  });
  return { id: created.id, title, privacy };
}

// Cached channel playlist list: one API read per run instead of one per folder.
let cachedList = null;

async function ensurePlaylist(title, privacy = 'unlisted', cache = new Map()) {
  if (cache.has(title)) return cache.get(title);

  if (!cachedList) cachedList = await listPlaylists();
  let playlist = cachedList.find((entry) => entry.title === title);
  if (!playlist) {
    playlist = await createPlaylist(title, privacy);
    cachedList.push(playlist);
  } else if (privacy && playlist.privacy !== privacy) {
    await api('playlists', {
      method: 'PUT',
      query: { part: 'status' },
      body: { id: playlist.id, status: { privacyStatus: privacy } },
    });
    playlist = { ...playlist, privacy };
    cachedList = cachedList.map((entry) => (entry.id === playlist.id ? playlist : entry));
  }
  cache.set(title, playlist);
  return playlist;
}

async function addVideoToPlaylist(playlistId, videoId) {
  await api('playlistItems', {
    method: 'POST',
    query: { part: 'snippet' },
    body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
  });
}

// Every video on the authenticated channel's uploads playlist (newest first).
// Cheap: channels.list = 1 unit, playlistItems = 1 unit per 50 videos.
async function listChannelVideos() {
  const channel = await api('channels', { query: { part: 'contentDetails', mine: 'true' } });
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return [];

  const videos = [];
  let pageToken;
  do {
    const page = await api('playlistItems', {
      query: { part: 'snippet,contentDetails', playlistId: uploads, maxResults: '50', pageToken },
    });
    for (const item of page.items || []) {
      videos.push({
        id: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId,
        title: (item.snippet?.title || '').trim(),
        visibility: '',
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return videos.filter((video) => video.id);
}

module.exports = {
  configured,
  listPlaylists,
  createPlaylist,
  ensurePlaylist,
  addVideoToPlaylist,
  listChannelVideos,
};
