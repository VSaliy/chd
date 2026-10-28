# SP Video Grabber

A Manifest V3 extension for Chrome and Edge that downloads SharePoint, OneDrive, Stream and Teams
meeting recordings **and their transcripts**. Everything runs inside the browser: stream discovery,
segment download, AES-128 decryption and MP4 muxing are written in TypeScript. No ffmpeg or yt-dlp
is started and nothing is sent anywhere except to your tenant hosts.

It only saves content that the signed-in user can already play. Authentication comes from the page's
own session and the tokens the page itself sends. The extension has no `webRequest` or `cookies`
permission and no analytics or remote code.

## Install (load unpacked)

```bash
npm install
npm run build        # writes dist/
```

* **Chrome:** open `chrome://extensions`, enable *Developer mode*, choose *Load unpacked* and select `dist/`.
* **Edge:** open `edge://extensions`, enable *Developer mode*, choose *Load unpacked* and select `dist/`.
  Edge uses the same Chromium extension APIs, so no changes are needed. Version 111 or newer is required.

A pre-built `dist/` is checked in so you can load it without building.

## Features

| Area | What it does |
| --- | --- |
| Stream discovery | 1) captured `videomanifest` requests (normalised to `part=index&format=dash`, plus `x-spopactoken` and the `Authorization: Bearer` header), 2) `g_fileInfo['.transformUrl']`, 3) `ListSchema[".videoManifestUrl"]` template from `RenderListDataAsStream` (captured, or fetched by POST), 4) `oneDrive.transcode` URLs with AES-128-CBC segments, 5) direct `?download=1` file (preferred when allowed) |
| Download engine | DASH MPD parsing, video+audio / video only / audio only (`.m4a`), quality presets (best, ≤1080p, ≤720p, manual), 1/2/4/8/16 parallel fetches, retry with backoff and `Retry-After` (8 attempts), token re-capture mid-download, progress with speed, ETA and bytes, clean cancel |
| Streaming to disk | Segments are written into OPFS (or a folder you pick with the File System Access API) and handed to `chrome.downloads`; no large Blob is built in memory |
| Transcripts | Raw JSON, WebVTT (`<v Speaker>` tags), SRT and grouped plain text with optional `[hh:mm:ss]` stamps. The last format is remembered |
| Folders / bulk | Detects `/:f:/[a-z]/<id>/<token>` share links, lists videos through the SharePoint REST API (optionally recursive), sorts by created / modified / name and queues the checked files (each is opened in a background tab for discovery, then closed) |
| Queue | Persistent in `chrome.storage.local`, add / remove / reorder / start / stop, optional retry on failure, finished items go to the bottom. Entry points: page button, popup "Add current video", context menu "Download with SP Video Grabber" on links, popup "Paste URL" |
| Naming | Template tokens `{title} {date} {time} {site} {quality} {id}`, Windows-safe sanitising, 150 character cap, `_1`, `_2` for duplicates, `video_{id}` for empty titles, subfolder under Downloads, editable transcript suffixes |
| Power-user export | "Copy command" for `yt-dlp` and `ffmpeg` built from the captured manifest URL, with a warning that the URL contains a short-lived token. Cookies are never exported |
| Capture fallback | Optional, off by default: records the playing `<video>` with `MediaRecorder` to WebM (takes as long as the video) |
| UI | Floating widget, command-bar "Download transcript" button, modals, toolbar badge (stream count, then progress), popup, options page with history and debug log, light/dark following the system, one-time responsible-use reminder |

## Supported URL shapes

* `https://<tenant>-my.sharepoint.com/personal/<user>/_layouts/15/stream.aspx?id=<path>`
* `https://<tenant>.sharepoint.com/sites/<site>/_layouts/15/stream.aspx?id=<path>`
* Teams meeting recordings opened in Teams, `teams.microsoft.com`, `teams.cloud.microsoft`
* `…/_layouts/15/onedrive.aspx?id=<folder>` and folder share links `/:f:/g/personal/<user>/<token>`
* The same hosts behind `*.sharepoint.com.mcas.ms` and `teams.microsoft.com.mcas.ms`, plus `*.svc.ms`

## Development

```bash
npm run typecheck   # strict TypeScript
npm test            # Vitest unit tests (fixtures in test/fixtures/)
npm run build       # esbuild -> dist/
npm run test:e2e    # Playwright + local mock SharePoint (needs ffmpeg, openssl and `npx playwright install chromium`)
```

Module layout:

* `src/lib/*` – pure, DOM-free, unit-tested logic: manifest URL normalisation, ListSchema template filling, MPD parsing, transcript conversion, filename sanitising, folder URL rewriting, retry, fMP4 muxer, host allow-list.
* `src/intercept.ts` – MAIN-world `fetch` / `XHR` patch, relays to the content script with `postMessage` and a per-session nonce.
* `src/content.ts`, `src/content-ui.ts` – isolated-world per-frame state, discovery, widget.
* `src/background.ts` – service worker: queue, context menu, `chrome.downloads`, offscreen coordination.
* `src/offscreen.ts`, `src/mux-worker.ts`, `src/engine/*` – long-running download, decrypt and mux work. The service worker never does it.
* `src/pages/*` – popup and options.

The end-to-end test serves a fake `stream.aspx`, a DASH MPD with fMP4 segments cut from a generated clip,
transcript JSON and a direct file from a local HTTPS server, loads `dist/` unpacked, and checks that the
muxed output plays and that its duration matches the source (it also exercises token expiry and re-capture).

## Known limitations

* **Guest / external users** often lack the REST and Graph permissions that discovery relies on; some strategies will fail.
* **Microsoft changes the UI and internal APIs** without notice. The `oneDrive.transcode` key format, `ListSchema` placeholders and command-bar selectors are best effort and may need updating.
* The output is a **fragmented MP4** (`moof`/`mdat`), which plays in browsers, VLC and ffmpeg, but some old editors want a remux (`ffmpeg -i in.mp4 -c copy out.mp4`).
* Not implemented: MP3 conversion via ffmpeg.wasm, subtitle tracks inside the MP4, pause/resume. After a failure a retry restarts the item; only a token expiry resumes in place.
* Segments with a `base_data_offset` in `tfhd` are not rewritten.
* The capture fallback produces WebM and runs in real time.
* The manifest and segments are fetched from the extension with the page's tokens; if your tenant blocks that with Conditional Access, use the "Copy command" export or the capture fallback.

## Credits

This project is a clean-room combination of ideas from these MIT-licensed projects. No source code was copied; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for their licence notices.

* [brendangooden/ms-teams-sharepoint-downloader](https://github.com/brendangooden/ms-teams-sharepoint-downloader) – base design
* [kylon/Sharedown](https://github.com/kylon/Sharedown) – `ListSchema` template method, folder download
* [PatBQc/SharePointVideoDownloader](https://github.com/PatBQc/SharePointVideoDownloader) – direct file and real-time capture ideas
* [dattmavis/ms-stream-video-downloader](https://github.com/dattmavis/ms-stream-video-downloader)
* [AbdulRhmanAbdulGhaffar/Share_Point_Downloader](https://github.com/AbdulRhmanAbdulGhaffar/Share_Point_Downloader)

## License

MIT, see [LICENSE](LICENSE).
