# ytup — upload a folder tree to YouTube, one playlist per folder

`ytup` uploads videos from a folder tree to your own YouTube channel, headless.
Each folder can become a playlist, runs are resumable, and a local upload log
stops files from being uploaded twice — even after you move or delete them.

```
node ytup.js [OPTIONS] PATH...
```

Paths are folders (their subfolders become playlists) or individual video files.

---

## Contents

- [Quick start](#quick-start)
- [Install](#install)
- [Setup (once)](#setup-once)
- [How it works](#how-it-works)
- [Command-line reference](#command-line-reference)
- [Folder → playlist](#folder--playlist)
- [Playlist modes](#playlist-modes)
- [Upload log and resuming](#upload-log-and-resuming)
- [Sync with the channel](#sync-with-the-channel)
- [Dry run](#dry-run)
- [Configuration file](#configuration-file)
- [Examples](#examples)
- [Environment](#environment)
- [Resource use](#resource-use)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [Files](#files)

---

## Quick start

```bash
npm install
npx tsc -p .            # builds dist/ from src/

node yt-login.js        # sign in to YouTube once, in a real Chrome window
node yt-oauth.js        # approve the Data API once (playlists)

node ytup.js --dry-run --playlist-depth 1 ~/Videos/Courses
node ytup.js --playlist-depth 1 --privacy unlisted ~/Videos/Courses
```

## Install

Requirements: Node.js 18+, Chrome/Chromium, a YouTube channel you own.

```bash
npm install          # puppeteer + puppeteer-real-browser
npx tsc -p .         # compiles src/ to dist/
```

`dist/` is not committed, so run `npx tsc -p .` after cloning and after editing
`src/`. `--dry-run`, `--help` and `--version` work without it.

## Setup (once)

### 1. Sign the browser in

```bash
node yt-login.js
```

This opens a visible Chrome window using the `yt-profile/` folder. Sign in,
open YouTube Studio once, then close the window (the script exits by itself).
Every later upload reuses that profile.

Use real Chrome (`/usr/bin/google-chrome-unstable` by default). Google refuses
sign-in from bundled Chromium builds. The profile is opened with
`--password-store=basic --use-mock-keychain`, the same flags the uploader uses;
a profile signed in with a different key store cannot decrypt its own cookies
on the next run and will silently look logged out.

### 2. OAuth client for playlists

1. Google Cloud Console → create/select a project.
2. Enable **YouTube Data API v3**.
3. Create an OAuth client ID of type **Desktop app**.
4. Save the JSON as `client_secret.json` next to `ytup.js`.
5. Approve once:

```bash
node yt-oauth.js
```

This opens a loopback browser flow (port 8788) and writes `token.json`. The
token refreshes itself.

An **API key cannot** be used for playlists: keys only read public data, while
creating playlists and adding videos require OAuth. Neither `client_secret.json`
nor `token.json` is committed.

## How it works

| Part | How | Why |
| --- | --- | --- |
| Video upload | Chrome automation, headless | The Data API caps unaudited projects at ~6 uploads/day. Browser uploads have no such cap. |
| Playlist create / privacy / membership | YouTube Data API v3 | Studio's playlist picker cannot reliably create a playlist with a chosen privacy, and changes between UI revisions. |
| Resume / no re-uploads | Local JSON ledger | Keyed by playlist + file name + size, so moving or deleting a file never re-uploads it. |
| Channel sync | Data API uploads playlist (Studio scrape as fallback) | Fast and exact; the scrape is only used when OAuth is not configured. |

Upload flow per file: open Studio → choose file → set title/description →
"not made for kids" → set visibility → dismiss the "still checking your content"
advisory with **Publish anyway** → read the video link → write the ledger →
add to the playlist via the API.

## Command-line reference

Every option, its values and its default:

| Option | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--playlist-depth N` | integer ≥ 0 | `1` | Folder levels that become playlists (1..N). `0` uploads flat, no playlists. |
| `--playlist-name MODE` | `leaf`, `path` | `leaf` | `leaf` uses the folder name; `path` joins the folders from the root. |
| `--playlist-separator TEXT` | text | ` / ` | Separator for `--playlist-name path`. |
| `--playlist-prefix TEXT` | text | none | Prefix for every playlist name. |
| `--title-prefix TEXT` | text | none | Prefix for every video title. |
| `--privacy VALUE` | `public`, `unlisted`, `private` | `unlisted` | Video visibility. |
| `--playlist-privacy VALUE` | `public`, `unlisted`, `private` | `unlisted` | Playlist visibility (API mode; existing playlists are corrected). |
| `--playlist-mode MODE` | `auto`, `api`, `ui`, `off` | `auto` | See [Playlist modes](#playlist-modes). |
| `--sort [ORDER]` | `name_asc`, `name_desc`, `mtime_asc`, `mtime_desc`, `random` | `name_asc` | Order of files inside each playlist. `--sort` without a value means `name_asc`. |
| `--skip` | flag | on | Skip files already in the upload log. |
| `--no-skip` | flag | — | Upload again even if the log says it was uploaded. |
| `--sync` | flag | off | Compare the tree with the channel, then upload what is left. |
| `--sync-only` | flag | off | Sync and exit without uploading. Implies `--sync`. |
| `--sync-pages N` | integer | `100` | Studio pages of 30 videos to read when the API is unavailable. |
| `--upload-log-file FILE` | path | `<root>/.youtube-upload-log.json` | Where the ledger lives. |
| `--delete-on-success` | flag | off | Delete each local file after it uploads successfully. |
| `--dry-run` | flag | off | Preview, then stop. No browser, API calls or writes. |
| `--batch-size N` | integer ≥ 0 | `25` | Restart Chrome every N uploads so one long session cannot accumulate memory. `0` keeps one browser for the whole run. |
| `--headless` | flag | on | Run Chrome without a window. |
| `--headed` | flag | — | Show the Chrome window (debugging). |
| `--version` | flag | — | Print the version. |
| `--help` | flag | — | Print the built-in help. |

Options take the next argument as their value; flags do not. Unknown options
exit with an error. The default `--playlist-depth` when individual files are
passed is `0` (no playlists).

## Folder → playlist

Tree used in the examples below:

```
Courses/
  Math/
    algebra.mp4
    Geometry/
      circles.mp4
  Physics/
    motion.mp4
  intro.mp4
```

- **Every folder from level 1 through N is a playlist.** With
  `--playlist-depth 2`: `Math`, `Math/Geometry`, `Physics`.
- **Each video goes to the deepest playlist that contains it**, so `algebra.mp4`
  lands in "Math" and `circles.mp4` in "Math / Geometry" — never in both.
- **Deeper folders roll up.** A file under `Math/Geometry/Advanced/` belongs to
  "Math / Geometry" at depth 2. With `"includeNested": false` such files are
  left out instead, and the dry run lists them.
- **Root-level videos** (`intro.mp4`) are ignored by default. Set
  `"orphanVideos": "upload"` to upload them without a playlist.
- **Naming**: `--playlist-name leaf` gives "Geometry"; `--playlist-name path`
  gives "Math / Geometry" (separator configurable).
- **Order**: folders are processed in natural name order (`Folder 2` before
  `Folder 10`); files follow `--sort`.
- **Extensions**: `.mp4 .mov .mkv .webm .avi .m4v .flv .wmv` by default
  (`videoExtensions` in the config).

Resulting playlists:

| Depth | Playlists | Where `algebra` / `circles` / `motion` go |
| --- | --- | --- |
| `0` | — | flat upload, all 4 videos including `intro` |
| `1` | Math, Physics | Math / Math / Physics (`intro` ignored) |
| `2` + `leaf` | Math, Geometry, Physics | Math / Geometry / Physics |
| `2` + `path` | Math, Math / Geometry, Physics | Math / Math / Geometry / Physics |

With `--playlist-prefix "Course: "` the names become "Course: Math" and
"Course: Math / Geometry".

## Playlist modes

| Mode | Behaviour |
| --- | --- |
| `api` | Creates missing playlists with `--playlist-privacy`, fixes the privacy of existing ones, and adds every uploaded video. Needs `client_secret.json` + `token.json`. |
| `ui` | Legacy alias for `api`, kept so older scripts keep working. Studio's playlist picker is no longer scriptable in current Studio builds, so it is never used. |
| `off` | No playlist handling at all; uploads are flat. |
| `auto` (default) | `api` when both OAuth files exist, otherwise `off` (with a warning at the start of the run). |

Creating a playlist and adding a video to one cost 50 quota units each; the free
10,000 units/day allow ~200 playlist operations. Video uploads do not consume
API quota because they go through the browser.

## Upload log and resuming

The log is `<root>/.youtube-upload-log.json` unless `--upload-log-file` or
`"ledger"` says otherwise:

```json
{
  "version": 1,
  "records": [
    {
      "relPath": "Math/algebra.mp4",
      "size": 123456,
      "mtimeMs": 1792693998121,
      "name": "algebra.mp4",
      "uploadedAt": "2026-10-22T18:40:48.944Z",
      "playlist": "Math",
      "title": "algebra",
      "link": "https://youtu.be/GlYEblY7R5Y",
      "videoId": "GlYEblY7R5Y",
      "playlistAddedAt": "2026-10-22T18:41:02.100Z"
    }
  ]
}
```

- **Skip key is playlist + file name + size**, not the path. Renaming a folder,
  moving a file or deleting it from disk never causes a second upload.
- `--no-skip` ignores the log and uploads again (the log then has two records).
- If a run dies between publishing and adding to the playlist, the next run
  repairs it: records with a `videoId` and no `playlistAddedAt` are added first.
- `--delete-on-success` removes each file right after it uploads; the record
  stays, so returning files with the same name and size are still skipped.
- The log is plain JSON — back it up with the folder, edit it by hand if needed.

## Sync with the channel

```bash
node ytup.js --sync-only ~/Videos/Courses     # report and adopt, then exit
node ytup.js --sync ~/Videos/Courses          # adopt, then upload the rest
node ytup.js --dry-run --sync ~/Videos/Courses
```

Sync reads every video on the channel (Data API uploads playlist; Studio
scraping when OAuth is not set up) and:

- **adopts** local files whose title matches a channel video that is not in the
  log — recorded with `adoptedFromStudio: true`, so they are skipped afterwards;
- **reports** log entries whose videos are no longer on the channel, e.g.
  `no longer on channel: deleted-video (https://youtu.be/…)`. Nothing is deleted
  from the log automatically.

Titles are compared case-insensitively and with collapsed whitespace. Duplicate
titles match the first (newest) channel video. A matched video must have the same
title as the planned upload (`--title-prefix` included).

`node test-sync.js` covers the matching rules offline.

## Dry run

`--dry-run` prints exactly what a real run would do and then stops:

```
root: /home/you/Videos/Courses
playlists: 3 | videos: 3 | skipped: 1
playlist mode: Data API | video privacy: unlisted | playlist privacy: unlisted

[playlist "Math"] 1 to upload, 1 skipped
  playlist: would create or reuse (unlisted)
  upload  Math/algebra.mp4  ->  "algebra"
  skip    Math/intro.mp4  (https://youtu.be/…)

[playlist "Math / Geometry"] 1 to upload, 0 skipped
  upload  Math/Geometry/circles.mp4  ->  "circles"

[playlist "Physics"] 1 to upload, 0 skipped
  upload  Physics/motion.mp4  ->  "motion"

log: …/.youtube-upload-log.json (not modified)
dry run: nothing created, uploaded, deleted or written
```

It opens no browser, makes no API calls, never writes the log and never deletes
a file. Files the plan does not cover are listed as `ignore` together with the
setting that would include them (root-level videos, or files deeper than
`--playlist-depth` with `includeNested: false`).

With `--sync --dry-run` the adoption preview says `would adopt` and the log
stays untouched.

## Configuration file

`upload.config.json` in the **current working directory** supplies defaults;
command-line flags override it.

```json
{
  "playlistDepth": 1,
  "playlistName": "leaf",
  "playlistSeparator": " / ",
  "playlistPrefix": "",
  "titlePrefix": "",
  "videoPrivacy": "unlisted",
  "playlistPrivacy": "unlisted",
  "order": "name_asc",
  "includeNested": true,
  "orphanVideos": "skip",
  "skipAlreadyUploaded": true,
  "ledger": ".youtube-upload-log.json",
  "description": "",
  "videoExtensions": [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv"]
}
```

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `playlistDepth` | integer ≥ 0 | `1` | Same as `--playlist-depth`. |
| `playlistName` | `leaf`, `path` | `leaf` | Same as `--playlist-name`. |
| `playlistSeparator` | text | ` / ` | Same as `--playlist-separator`. |
| `playlistPrefix` | text | `""` | Same as `--playlist-prefix`. |
| `titlePrefix` | text | `""` | Same as `--title-prefix`. |
| `videoPrivacy` | `public`, `unlisted`, `private` | `unlisted` | Same as `--privacy`. |
| `playlistPrivacy` | `public`, `unlisted`, `private` | `unlisted` | Same as `--playlist-privacy`. |
| `order` | `name_asc`, `name_desc`, `mtime_asc`, `mtime_desc`, `random` | `name_asc` | Same as `--sort`. |
| `includeNested` | boolean | `true` | `false` leaves out files deeper than the playlist depth instead of rolling them up. |
| `orphanVideos` | `skip`, `upload` | `skip` | What to do with videos directly in the root. |
| `skipAlreadyUploaded` | boolean | `true` | Default for `--skip` / `--no-skip`. |
| `ledger` | path | `.youtube-upload-log.json` | Log file, relative to the root. `--upload-log-file` wins. |
| `description` | text | `""` | Description applied to every uploaded video. |
| `videoExtensions` | array | 8 common extensions | Which files count as videos. |

`upload.config.example.json` in the repository is a ready copy.

## Examples

### First run, safely

```bash
# preview what would happen — nothing is created or uploaded
node ytup.js --dry-run --playlist-depth 1 ~/Videos/Courses

# same plan, for real, videos unlisted
node ytup.js --playlist-depth 1 --privacy unlisted ~/Videos/Courses
```

### Playlists

```bash
# one playlist per first-level folder
node ytup.js --playlist-depth 1 ~/Videos/Courses

# parent and child playlists: "Math", "Math / Geometry", "Physics"
node ytup.js --playlist-depth 2 --playlist-name path ~/Videos/Courses

# a different separator and a prefix on every playlist
node ytup.js --playlist-depth 2 --playlist-name path \
  --playlist-separator " — " --playlist-prefix "Course: " ~/Videos/Courses

# leaf names only at depth 2: "Math", "Geometry", "Physics"
node ytup.js --playlist-depth 2 ~/Videos/Courses

# no playlists at all, everything flat and public
node ytup.js --playlist-depth 0 --privacy public ~/Videos/Courses
```

### Privacy

```bash
node ytup.js --privacy private ~/Videos/Courses                  # private videos
node ytup.js --playlist-privacy public ~/Videos/Courses          # public playlists
node ytup.js --privacy public --playlist-privacy public ~/Videos/Courses
```

### Titles and order

```bash
node ytup.js --title-prefix "Lesson 1 — " ~/Videos/Courses
node ytup.js --sort mtime_desc ~/Videos/Courses      # newest files first
node ytup.js --sort random ~/Videos/Courses          # shuffles playlist order
node ytup.js --sort                                 # name_asc
```

### Resume, force, delete

```bash
node ytup.js ~/Videos/Courses                  # skips everything already logged
node ytup.js --no-skip ~/Videos/Courses        # upload again on purpose
node ytup.js --delete-on-success ~/Videos/Courses
node ytup.js --upload-log-file ~/logs/courses.json ~/Videos/Courses
```

### Sync

```bash
node ytup.js --sync-only ~/Videos/Courses      # adopt existing, report missing
node ytup.js --sync ~/Videos/Courses           # adopt, then upload the rest
node ytup.js --dry-run --sync ~/Videos/Courses # preview adoption only
```

### Recover an interrupted run

```bash
node ytup.js --playlist-mode api ~/Videos/Courses
```

Videos that were published but never added to their playlist are repaired before
any new upload starts.

### Legacy ui mode and no playlists

```bash
node ytup.js --playlist-mode ui ~/Videos/Courses   # legacy alias, same as api
node ytup.js --playlist-mode off ~/Videos/Courses  # ignore playlists entirely
```

### Single files and debugging

```bash
node ytup.js --dry-run ./lecture-01.mp4 ./lecture-02.mp4
node ytup.js ./lecture-01.mp4
node ytup.js ~/Videos/Courses ~/Desktop/extra-talk.mp4   # tree + one loose file
node ytup.js --headed --playlist-depth 1 ~/Videos/Courses   # watch the browser
```

### Verify a playlist

```bash
node verify-playlist.js "Math"
```

Prints the playlist id, privacy and its video ids/titles via the Data API.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHROME_PATH` | `/usr/bin/google-chrome-unstable` | Chrome/Chromium binary used for uploads and `yt-login.js`. |
| `YTUP_LOW_RESOURCE` | `1` | Set to `0` to disable the low-footprint Chrome tuning described under [Resource use](#resource-use). |

`yt-login.js` also accepts `CHROME_PATH` and defaults to the same binary.

## Resource use

Bulk uploads run for hours and YouTube Studio is a heavy single-page app, so
`ytup` keeps Chrome as small as it can without changing what gets uploaded:

- Chrome runs at nice 10; other applications win when the CPU is contended.
- Site images are not fetched and Studio's looping CSS animations are finished
  immediately, cutting image-decode and repaint work.
- Chrome is restarted every 25 uploads (`--batch-size`). A fresh browser
  releases the renderer's accumulated DOM, image and JavaScript memory instead
  of letting one session grow for the whole run. Each restart reuses the saved
  profile, so no login is needed.
- The process limit is lowered to two renderers: Studio only needs the page and
  an occasional helper frame.

What these do not change: YouTube itself keeps the upload dialog polling while
a video is processed, which costs CPU and around 0.7-1.1 GB of renderer memory
per browser session. On a small machine, closing other browsers and background
apps during a long run helps more than any uploader flag.

`YTUP_LOW_RESOURCE=0` turns the tuning off (useful when debugging a Studio UI
change); `--batch-size 0` disables the restarts.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `no input path given` | Pass a folder or files; run `--help`. |
| `invalid --privacy` | Values are exactly `public`, `unlisted`, `private`. |
| `playlist mode "api" needs client_secret.json and token.json` | Create the OAuth client and run `node yt-oauth.js`, or use `--playlist-mode off` if you do not want playlists. |
| Studio shows the login page during upload | The profile's cookies cannot be decrypted. Re-run `node yt-login.js`; do not copy `yt-profile/` between machines. |
| `SingletonLock` / `connect ECONNREFUSED` | A crashed run left Chrome holding the profile. `ytup` now kills Chrome processes bound to `yt-profile/` and removes `SingletonLock`, `SingletonSocket` and `DevToolsActivePort` automatically at startup and on failure/interrupt. Remove them by hand only if the process was killed with `SIGKILL`. |
| Upload ends as "Processing abandoned" | YouTube rejects very short or truncated files (a few KB). Use complete videos. |
| "We're still checking your content" dialog | Dismissed automatically with **Publish anyway**, exactly like doing it by hand. |
| Video title is doubled (`clipclip`) | Fixed: Studio's pre-filled title is replaced with select-all + Backspace. Rebuild with `npx tsc -p .`. |
| Playlist not created | Check the OAuth project has **YouTube Data API v3** enabled and `token.json` belongs to the channel owner. |
| `403 quotaExceeded` | The daily 10,000-unit API quota is spent (~200 playlist operations). Uploads still work; playlists resume tomorrow. |
| Upload stops on the first failing video | Intentional: the error is reported and earlier successes are kept in the log; playlists for finished videos are still added, and re-running resumes. |

## Tests

```bash
npm test                  # offline suites below

node test-dry-run.js      # 12 cases: planning, skips, ledger immutability, no dist/
node test-sync.js         # 8 cases: title matching, missing videos, path-independent keys

node test-upload-live.js  # real uploads + API verification (~25-40 min)
```

The offline suites use no browser, no network and change nothing on the channel.
They create their trees under `/tmp/opencode` (override with `YTUP_TEST_DIR`).

### Live upload tests

`test-upload-live.js` really uploads short clips and checks the result through
the Data API: playlist creation and privacy, membership, order, titles,
roll-up/deepest assignment, depth 0, playlist modes `off` and the legacy
`ui` alias, `--delete-on-success`, skip and `--no-skip`, and sync adoption. Every name is
prefixed with a unique marker (`LIVE<stamp>`, override with `LIVE_STAMP`), and
the run ends by confirming every uploaded title exists on the channel and that
the ignored root-level file does not.

It costs ~12 unlisted uploads and ~1,000 API quota units, and writes a report
with every created playlist and video id. Remove that content afterwards:

```bash
node cleanup-live-tests.js /tmp/opencode/ytup-live-<stamp>.json --yes
```

Without `--yes` the cleanup script only lists what it would delete.

## Files

| File | Purpose |
| --- | --- |
| `ytup.js` | CLI: arguments, planning, skip logic, upload loop, playlist repair. |
| `tree-plan.js` | Folder → playlist planning, sorting, defaults. Pure filesystem logic. |
| `ledger.js` | Upload log: load/save, `dest:playlist:name:size` key, fingerprints. |
| `sync.js` | Channel video list (API uploads playlist, Studio scrape fallback) and reconcile. |
| `ytplaylists.js` | Data API: list/create playlists, fix privacy, add videos, list channel uploads. |
| `yt-oauth.js` | One-time Desktop OAuth loopback flow → `token.json`. |
| `yt-login.js` | Interactive sign-in into `yt-profile/`. |
| `verify-playlist.js` | Print a playlist's contents (`node verify-playlist.js "Name"`). |
| `src/upload.ts` | Chrome automation (patched library: headless, visibility UI, titles). |
| `dist/` | Built library (`npx tsc -p .`), not committed. |
| `test-dry-run.js`, `test-sync.js` | Offline tests. |
| `client_secret.json`, `token.json`, `yt-profile/` | Credentials and session — gitignored. |
