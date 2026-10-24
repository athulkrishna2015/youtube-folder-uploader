<h1 align="center">YouTube Folder Uploader — <code>ytup</code></h1>

<p align="center">Upload a folder tree to your own YouTube channel, headless.<br>
Each folder becomes a playlist, runs resume, and nothing is uploaded twice.</p>

> **Fork of [fawazahmed0/youtube-uploader](https://github.com/fawazahmed0/youtube-uploader).**
> This fork adds the `ytup` command-line uploader on top of the original library.
> The library API (`upload`, `update`, `comment`) is still available — see
> [Library API](#library-api). Full CLI documentation: **[YTUP.md](YTUP.md)**.

---

## Why this fork

The YouTube Data API caps unaudited projects at roughly **6 uploads per day**.
`ytup` uploads videos through Chrome automation instead, so the channel's own
limits apply, while playlists (creation, privacy, membership) go through the
Data API where they are exact and cheap.

| Part | How |
| --- | --- |
| Video upload | Headless Chrome with a persistent profile (`yt-profile/`) |
| Playlist create / privacy / membership | YouTube Data API v3 (OAuth desktop client) |
| Resume / no duplicates | Local JSON ledger keyed by playlist + file name + size |
| Channel sync | Data API uploads playlist; Studio scrape as fallback |

## Features

- **Folder → playlist**: every folder from level 1 to N becomes a playlist;
  each video goes to the deepest one, deeper files roll up.
- **Names your way**: leaf or path names, custom separator, playlist and title
  prefixes, natural sort or mtime/random ordering.
- **Resume forever**: the ledger is keyed by playlist + name + size, so moving,
  renaming or deleting a file never causes a second upload.
- **Sync with the channel**: adopt videos that are already uploaded (matched by
  title) and report ledger entries that vanished from the channel.
- **`--dry-run`**: prints playlists, titles, skips and ignored files without a
  browser, API call or write.
- **`--delete-on-success`**, skip / `--no-skip`, privacy control for videos and
  playlists, and automatic repair of playlist adds interrupted mid-run.
- **Legacy `ui` mode** accepted as an alias for `api`; current Studio builds no
  longer expose a scriptable playlist picker.

## Requirements

- Node.js 18+
- Real Google Chrome (not Chromium — Google refuses sign-in there)
- A YouTube channel you own
- An OAuth **Desktop app** client for playlist management

## Install

```bash
git clone https://github.com/athulkrishna2015/youtube-folder-uploader.git
cd youtube-folder-uploader
npm install
npx tsc -p .          # builds dist/ (not committed)
```

Sign in once:

```bash
node yt-login.js      # opens Chrome; sign in and open YouTube Studio
node yt-oauth.js      # approves the Data API (playlists)
```

`client_secret.json`, `token.json` and `yt-profile/` stay local and are
gitignored. See [Setup (once)](YTUP.md#setup-once) for the Cloud Console steps.

## Quick start

```bash
# preview: playlists, titles, skips — no browser, no API, no writes
node ytup.js --dry-run --playlist-depth 1 ~/Videos/Courses

# for real: one playlist per first-level folder, videos unlisted
node ytup.js --playlist-depth 1 --privacy unlisted ~/Videos/Courses
```

Given:

```
Courses/
  Math/
    algebra.mp4
    Geometry/circles.mp4
  Physics/motion.mp4
  intro.mp4
```

`--playlist-depth 2 --playlist-name path` creates `Math`, `Math / Geometry`
and `Physics`; `algebra.mp4` goes to `Math`, `circles.mp4` to
`Math / Geometry`, `motion.mp4` to `Physics`. Root-level `intro.mp4` is
ignored by default (set `"orphanVideos": "upload"` to include it).

## Common options

| Option | Default | Meaning |
| --- | --- | --- |
| `--playlist-depth N` | `1` | Folder levels that become playlists. `0` = flat upload. |
| `--playlist-name MODE` | `leaf` | `leaf` folder name, or `path` from the root. |
| `--playlist-separator TEXT` | ` / ` | Separator for `path` names. |
| `--playlist-prefix TEXT` | — | Prefix for every playlist name. |
| `--title-prefix TEXT` | — | Prefix for every video title. |
| `--privacy VALUE` | `unlisted` | `public`, `unlisted` or `private`. |
| `--playlist-privacy VALUE` | `unlisted` | Same values; existing playlists are corrected. |
| `--playlist-mode MODE` | `auto` | See [Playlist modes](#playlist-modes). |
| `--sort [ORDER]` | `name_asc` | `name_asc`, `name_desc`, `mtime_asc`, `mtime_desc`, `random`. |
| `--skip` / `--no-skip` | skip on | Skip or force files already in the ledger. |
| `--sync` / `--sync-only` | off | Adopt channel videos, then upload (or stop). |
| `--delete-on-success` | off | Delete each local file after it uploads. |
| `--dry-run` | off | Preview and stop; nothing is created or written. |
| `--batch-size N` | `25` | Restart Chrome every N uploads to bound memory. `0` never restarts. |
| `--headless` / `--headed` | headless | Run Chrome without or with a window. |

Every option, value, default and example is in **[YTUP.md](YTUP.md)**.

## Playlist modes

| Mode | Behaviour |
| --- | --- |
| `api` | Creates missing playlists with the chosen privacy, fixes existing ones, adds every uploaded video. Needs OAuth. |
| `ui` | **Legacy alias for `api`** — kept so older scripts work. Studio's picker is no longer scriptable, so it is never used. |
| `off` | No playlist handling; uploads are flat. |
| `auto` (default) | `api` when `client_secret.json` and `token.json` exist, otherwise `off` with a warning. |

Playlist creates and adds cost 50 quota units each (10,000/day by default);
video uploads cost none because they use the browser.

## Resume, sync and repairs

```bash
node ytup.js ~/Videos/Courses            # skips everything already uploaded
node ytup.js --no-skip ~/Videos/Courses  # force a second upload
node ytup.js --sync-only ~/Videos/Courses  # adopt + report missing, no upload
node ytup.js --sync ~/Videos/Courses       # adopt, then upload what is left
```

The ledger lives at `<root>/.youtube-upload-log.json`. If a run dies after
publishing but before the playlist add, the next run repairs the missing add
before uploading anything new.

## Tests

```bash
npm test                 # offline: 12 dry-run cases + 8 sync cases
node test-upload-live.js # real uploads + Data API verification (~25–40 min,
                         # ~12 unlisted videos, ~1,000 quota units)
```

The live suite prints a report with every created playlist and video id:

```bash
node cleanup-live-tests.js /tmp/opencode/ytup-live-<stamp>.json --yes
```

Interrupt a live run at any point and continue with
`LIVE_RESUME=1 LIVE_STAMP=<same-stamp> node test-upload-live.js`; per-run logs
are kept under `/tmp/opencode/ytup-live-<stamp>/runs/`. Every test title carries
a unique `LIVE<stamp>` prefix so cleanup can never touch other content.

## Library API

The original library is still exported from this fork. Note that playlist
assignment through the library is not supported here — use the CLI with
`--playlist-mode api` instead (the `playlist` field is ignored).

**In the name of God, who has guided me to do this work**

### Uploading a video

```js
import { upload } from 'youtube-videos-uploader' // TypeScript
// OR
const { upload } = require('youtube-videos-uploader') // JavaScript

// recoveryemail is optional, only needed if Google asks for confirmation
const credentials = { email: 'Your Email', pass: 'Your Password', recoveryemail: 'Your Recovery Email' }

const video1 = { path: 'video1.mp4', title: 'title 1', description: 'description 1' }

const onVideoUploadSuccess = (videoUrl) => {
    // ..do something..
}

const video2 = { path: 'video2.mp4', title: 'title 2', description: 'description 2', thumbnail: 'thumbnail.png', language: 'english', tags: ['video', 'github'], channelName: 'Channel Name', onSuccess: onVideoUploadSuccess, skipProcessingWait: true, onProgress: (progress) => { console.log('progress', progress) }, uploadAsDraft: false, isAgeRestriction: false, isNotForKid: false, publishType: 'PUBLIC', isChannelMonetized: false }

// Returns uploaded video links in an array
upload(credentials, [video1, video2]).then(console.log)

// Pass Puppeteer launch options as the third argument
upload(credentials, [video1, video2], { headless: false }).then(console.log)
// https://pptr.dev/#?product=Puppeteer&version=main&show=api-puppeteerlaunchoptions
```

Output:

```js
[ 'https://youtu.be/fh2Kreex5Eg', 'https://youtu.be/fh2Krefx5Eg' ]
```

### Updating metadata

```js
import { update } from 'youtube-videos-uploader'
// OR
const { update } = require('youtube-videos-uploader')

const credentials = { email: 'Your Email', pass: 'Your Password', recoveryemail: 'Your Recovery Email' }

const videoUpdate1 = { link: 'https://www.youtube.com/watch?v=w3jLJU7DT5E', title: 'Your New Title' }

const onVideoUpdateSuccess = (videoUrl) => {
    // ..do something..
}

const videoUpdate2 = { link: 'https://www.youtube.com/watch?v=w3jLJU7DT5E', title: 'title 2', description: 'description 2', thumbnail: 'thumbnail.png', language: 'english', tags: ['video', 'github'], replaceTags: ['mytag'], channelName: 'Channel Name', publishType: 'unlisted', publishToSubscriptionFeedAndNotifySubscribers: false, onSuccess: onVideoUpdateSuccess }

update(credentials, [videoUpdate1, videoUpdate2]).then(console.log)
update(credentials, [videoUpdate1, videoUpdate2], { headless: false }).then(console.log)
```

### Commenting on a video

```js
import { comment } from 'youtube-videos-uploader'
// OR
const { comment } = require('youtube-videos-uploader')

const credentials = { email: 'Your Email', pass: 'Your Password', recoveryemail: 'Your Recovery Email' }

const comment1 = { link: 'https://www.youtube.com/watch?v=jEevRjRglFY', comment: 'Your comment', pin: false }

comment(credentials, [comment1]).then(console.log)
comment(credentials, [comment1], { headless: false }).then(console.log)
```

## Contributors 🎉

- [Pierre Miniggio( @pierreminiggio )](https://ggio.link/twitter) - For Adding [Youtube UI English Language Support](https://github.com/fawazahmed0/youtube-uploader/pull/16), [JSDoc](https://github.com/fawazahmed0/youtube-uploader/pull/18), [debug message](https://github.com/fawazahmed0/youtube-uploader/pull/34), [Cleanup](https://github.com/fawazahmed0/youtube-uploader/pull/67), [shorts link refactor](https://github.com/fawazahmed0/youtube-uploader/pull/140), [log handling](https://github.com/fawazahmed0/youtube-uploader/pull/144) and [close browser on error](https://github.com/fawazahmed0/youtube-uploader/pull/155)
- [TentacleSama4254 ](https://github.com/TentacleSama4254) - For Adding [Thumbnail option](https://github.com/fawazahmed0/youtube-uploader/pull/22), fixing [tags error](https://github.com/fawazahmed0/youtube-uploader/pull/23), [TypeScript Rewrite, storing login session](https://github.com/fawazahmed0/youtube-uploader/pull/51), [video metadata update feature](https://github.com/fawazahmed0/youtube-uploader/pull/53) and [comments option](https://github.com/fawazahmed0/youtube-uploader/pull/58)
- [Sai Charan](https://github.com/charan0017) - For [onSuccess Option](https://github.com/fawazahmed0/youtube-uploader/pull/32)
- [Tue Nguyen](https://github.com/TueeNguyen) - For [Better error messages](https://github.com/fawazahmed0/youtube-uploader/pull/46)
- [weizhiqimail](https://github.com/weizhiqimail) - For [Extra Debug messages](https://github.com/fawazahmed0/youtube-uploader/pull/47)
- [DaddyFrosty](https://github.com/DaddyFrosty) - For [Path Escaping](https://github.com/fawazahmed0/youtube-uploader/pull/55), [Skip Processing wait](https://github.com/fawazahmed0/youtube-uploader/pull/57), [onProgress event](https://github.com/fawazahmed0/youtube-uploader/pull/60), [Show More being toggled incorrectly…](https://github.com/fawazahmed0/youtube-uploader/pull/180) and [Added support for selecting "Gaming" category aswell as game.](https://github.com/fawazahmed0/youtube-uploader/pull/182)
- [Owl Burger](https://github.com/Zebraslive) - For [Create Channel](https://github.com/fawazahmed0/youtube-uploader/pull/66)
- [Ítalo Andrade](https://github.com/italodeandra) - For [Channel Switcher](https://github.com/fawazahmed0/youtube-uploader/pull/73)
- [Dominic Findlay](https://github.com/DominicFindlay) - For Supporting [Single Quotes in playlist name](https://github.com/fawazahmed0/youtube-uploader/pull/82), [skip processing bug fix](https://github.com/fawazahmed0/youtube-uploader/pull/162) and [wait for upload complete](https://github.com/fawazahmed0/youtube-uploader/pull/225)
- [Dement6d](https://github.com/dement6d) - For [Better error messages](https://github.com/fawazahmed0/youtube-uploader/pull/99) & [handling 2FA](https://github.com/fawazahmed0/youtube-uploader/pull/101)
- [coooo77](https://github.com/coooo77) - For [uploading videos as draft option](https://github.com/fawazahmed0/youtube-uploader/pull/105)
- [L1teleau](https://github.com/L1teleau) - For [upload limit reached message](https://github.com/fawazahmed0/youtube-uploader/pull/115)
- [Sacredrel1c](https://github.com/sacredrel1c) - For [channel stuck due to no drop down menu](https://github.com/fawazahmed0/youtube-uploader/pull/118), [upload endless wait fix](https://github.com/fawazahmed0/youtube-uploader/pull/125), [click fix](https://github.com/fawazahmed0/youtube-uploader/pull/133), [Recursive lang change](https://github.com/fawazahmed0/youtube-uploader/pull/137), [publish short comment](https://github.com/fawazahmed0/youtube-uploader/pull/219) and [Fix youtube login](https://github.com/fawazahmed0/youtube-uploader/pull/228)
- [Chipped1](https://github.com/Chipped1) - For [Google login fix](https://github.com/fawazahmed0/youtube-uploader/pull/127)
- [Jared L](https://github.com/lhjt) - For [customSelectorUrl config option](https://github.com/fawazahmed0/youtube-uploader/pull/139)
- [Tiago Severino](https://github.com/TiagoSeverino) - For [Replacing readline](https://github.com/fawazahmed0/youtube-uploader/pull/157) and [Daily limit issue](https://github.com/fawazahmed0/youtube-uploader/pull/160)
- [PeterStegarus](https://github.com/PeterStegarus) - For [Daily upload error message](https://github.com/fawazahmed0/youtube-uploader/pull/163)
- [Kudou Sterain](https://github.com/hotrungnhan) - For [isAgeRestriction, isNotForKid option and other fixes](https://github.com/fawazahmed0/youtube-uploader/pull/175)
- [Andrew Glago](https://github.com/a11rew) - For [pinning option for comments](https://github.com/fawazahmed0/youtube-uploader/pull/186)
- [nhantamz](https://github.com/nhantamz) - For [setting english as default language](https://github.com/fawazahmed0/youtube-uploader/pull/191)
- [Damian](https://github.com/ClassAxion) - For [publish type support](https://github.com/fawazahmed0/youtube-uploader/pull/198), [Close browser before error](https://github.com/fawazahmed0/youtube-uploader/pull/201), [isChannelMonetized](https://github.com/fawazahmed0/youtube-uploader/pull/203) option, [PR build status check](https://github.com/fawazahmed0/youtube-uploader/pull/205), [improve monetization code](https://github.com/fawazahmed0/youtube-uploader/pull/206) and [userDataDir option](https://github.com/fawazahmed0/youtube-uploader/pull/213)
- [Soubhik Biswas](https://github.com/s0ubhik) - For [fixing home page selector](https://github.com/fawazahmed0/youtube-uploader/pull/229)
- [pm96](https://github.com/pm96) - For [publishToSubscriptionFeedAndNotifySubscribers](https://github.com/fawazahmed0/youtube-uploader/pull/232) option
- [bmarotta](https://github.com/bmarotta) - For [Enhanced logs and workarounds](https://github.com/fawazahmed0/youtube-uploader/pull/236)
