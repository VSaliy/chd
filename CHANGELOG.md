# Changelog

## 0.1.0

* **M1** Stream discovery (manifest capture, `g_fileInfo`, `ListSchema`, `oneDrive.transcode`, direct file) and the download engine: MPD parsing, parallel fetch with retry, AES-128-CBC decrypt, own fMP4 muxer, OPFS / folder sinks, token re-capture, cancel.
* **M2** Transcripts: JSON, WebVTT, SRT, grouped text; proactive Graph-style fallback; remembered format.
* **M3** Persistent queue, filename templates and sanitising, duplicate naming, history.
* **M4** Folder share-link detection, REST listing, sorting, bulk queueing through background tabs.
* **M5** `yt-dlp` / `ffmpeg` command export and optional real-time capture fallback.
* **M6** Popup, options page, badge, themes, first-run reminder, unit tests and Playwright end-to-end test.
