# ytup — upload a folder tree to YouTube, one playlist per folder

Headless uploader for your own channel. Each folder can become a playlist,
uploads are resumable, and a local upload log stops files from being uploaded
twice — even after you delete them from disk.

```
node ytup.js [OPTIONS] PATH...
```

`PATH` is a folder (its subfolders become playlists) or one or more video files.

## Why the browser + API mix

| Part | How | Why |
| --- | --- | --- |
| Video upload | Chrome automation (headless) | The Data API caps an unaudited project at ~6 uploads/day and forces private. Browser uploads have no such cap. |
| Playlist create / privacy / add video | YouTube Data API v3 | Studio's playlist picker cannot create a playlist with a chosen privacy reliably, and breaks between UI revisions. API calls cost 50 units each (10,000/day free). |

Uploads still go through the same browser session, so playlists add no upload limit.

## Install

```bash
npm install          # puppeteer + puppeteer-real-browser
npx tsc -p .         # builds dist/ from src/ (dist is not committed)
```

`ytup.js` runs from `dist/`, so rebuild with `npx tsc -p .` after editing `src/`.

## Setup (once)

1. **Sign in with Chrome** — the session lives in `yt-profile/`, not cookies exported from another browser:

   ```bash
   node yt-login.js          # opens a real Chrome window; sign in; it closes itself
   ```

   Use the real Chrome (`/usr/bin/google-chrome-unstable`). Google refuses sign-in
   from bundled/automated Chromium. Keep `--password-store=basic` in that script:
   a profile signed in with a different key store cannot decrypt its own cookies
   on the next run and silently appears logged out.

2. **OAuth client for playlists** — Google Cloud Console → enable *YouTube Data API v3*
   → OAuth client ID (*Desktop app*) → save the JSON as `client_secret.json`
   next to `ytup.js`, then:

   ```bash
   node yt-oauth.js          # approve once in the browser; writes token.json
   ```

`token.json` refreshes itself. An **API key cannot** be used here: keys only read
public data, while creating playlists and adding videos need OAuth.

## Examples

```bash
# every first-level folder becomes a playlist, videos unlisted
node ytup.js --playlist-depth 1 --privacy unlisted ~/Videos/Courses

# nested playlists named "Parent / Child", public playlists
node ytup.js --playlist-depth 2 --playlist-name path --playlist-prefix "Course: " \
  --playlist-privacy public ~/Videos/Courses

# preview playlists/files/skips without creating or uploading anything
node ytup.js --dry-run --playlist-depth 2 ~/Videos/Courses

# adopt videos that are already on the channel (matched by title) into the log
node ytup.js --sync-only ~/Videos/Courses

# upload and delete each file after it succeeds
node ytup.js --playlist-depth 1 --delete-on-success ~/Videos/Courses
```

## Dry run

`--dry-run` prints exactly what a real run would do and then stops:

```
root: /home/you/Videos/Courses
playlists: 2 | videos: 3 | skipped: 1
playlist mode: Data API | video privacy: unlisted | playlist privacy: unlisted

[playlist "Math"] 2 to upload, 1 skipped
  playlist: would create or reuse (unlisted)
  upload  Math/algebra.mp4  ->  "algebra"
  upload  Math/Geometry/circles.mp4  ->  "circles"
  skip    Math/intro.mp4  (https://youtu.be/…)

[playlist "Physics"] 1 to upload, 0 skipped
  upload  Physics/motion.mp4  ->  "motion"

log: …/.youtube-upload-log.json (not modified)
dry run: nothing created, uploaded, deleted or written
```

It opens no browser, makes no API calls, never writes the log and never deletes
a file, so it is safe to run before every batch. Files the plan does not cover
are listed as `ignore` with the setting that would include them.

Run the checks with `node test-dry-run.js` (11 cases: skips, ledger untouched,
nested playlist assignment, depth 0, no `dist/` required, and more).

## Folder → playlist

With `--playlist-depth 2` and `--playlist-name path`:

```
Courses/
  Math/            → playlist "Math"
    algebra.mp4
    Geometry/      → playlist "Math / Geometry"
      circles.mp4
  Physics/         → playlist "Physics"
    motion.mp4
```

- `--playlist-depth N` — every folder from level 1 through N becomes a playlist.
  `0` uploads flat, with no playlists.
- Each video is assigned to the **deepest** playlist that contains it, so
  `Math/algebra.mp4` goes to "Math" and `Math/Geometry/circles.mp4` goes to
  "Math / Geometry" — never to both.
- A folder nested deeper than the depth **rolls up** to its level-N ancestor
  (`includeNested: true`, the default). Set `"includeNested": false` to leave
  those files out; the dry run lists them instead of hiding them.
- `--playlist-name leaf|path` — folder name only, or the full path joined with
  `--playlist-separator` (default ` / `).
- Videos directly in the root are ignored unless `"orphanVideos": "upload"`;
  the dry run lists them too.
- Folders are processed in natural name order; files follow `--sort`
  (`name_asc`, `name_desc`, `mtime_asc`, `mtime_desc`, `random`).

## Resume and no re-uploads

The log lives at `<root>/.youtube-upload-log.json` (or `--upload-log-file`):

```json
{
  "relPath": "Math/algebra.mp4",
  "size": 123456,
  "name": "algebra.mp4",
  "playlist": "Math",
  "link": "https://youtu.be/…",
  "videoId": "…",
  "playlistAddedAt": "2026-10-22T13:18:01.563Z"
}
```

The **skip key is playlist + file name + size**, not the local path, so moving or
deleting files never causes a re-upload. Skipping is on by default; `--no-skip`
forces a re-upload.

If a run dies between publishing a video and adding it to its playlist, the next
run repairs it: records with a `videoId` and no `playlistAddedAt` are added before
uploading starts.

`--sync` reads the channel's videos (API uploads playlist when OAuth is set up,
Studio scraping otherwise) and:

- **adopts** local files whose title already exists on the channel,
- **reports** log entries whose videos are no longer on the channel.

## Playlist modes

| Mode | Behaviour |
| --- | --- |
| `api` (default when `client_secret.json` + `token.json` exist) | Creates missing playlists with `--playlist-privacy`, corrects wrong privacy, adds each video after upload. |
| `ui` (fallback, no OAuth) | Adds videos to **existing** playlists only, through Studio's picker. |
| `off` | No playlist handling. |

## Config file

`upload.config.json` in the working directory supplies defaults; flags override it:

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
  "videoExtensions": [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv"]
}
```

## Notes

- Title and description are set by replacing Studio's auto-filled text, so a file
  named `lecture-01.mp4` becomes a video titled `lecture-01`, not `lecture-01lecture-01`.
- YouTube shows "We're still checking your content" for fresh channels; the uploader
  clicks **Publish anyway** (the same as doing it by hand).
- Very short or truncated clips are rejected by YouTube as *Processing abandoned* —
  the upload is reported as successful, but the video never becomes available.
- Verified end to end: folder → playlist (`unlisted`) → headless upload →
  video in playlist, and a second run skipping everything.
