"use strict";
(() => {
  // src/lib/manifestUrl.ts
  function isManifestUrl(url) {
    return url.includes("videomanifest") && !url.includes("tempauth");
  }
  function normalizeManifestUrl(url) {
    const u = new URL(url);
    u.searchParams.set("part", "index");
    u.searchParams.set("format", "dash");
    return u.toString();
  }
  function manifestFromTransformUrl(transformUrl, base) {
    let u;
    try {
      u = new URL(transformUrl, base);
    } catch {
      return null;
    }
    const marker = "/transform/";
    const i = u.pathname.toLowerCase().indexOf(marker);
    if (i < 0) return null;
    u.pathname = u.pathname.slice(0, i + marker.length) + "videomanifest";
    return normalizeManifestUrl(u.toString());
  }

  // src/lib/listSchema.ts
  function str(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
  }
  function buildManifestFromListData(data, rowIndex = 0) {
    const schema = data.ListSchema ?? {};
    const template = str(schema[".videoManifestUrl"]);
    if (!template) return null;
    const rows = data.ListData?.Row ?? data.Row ?? [];
    const row = rows[rowIndex] ?? {};
    const pick = (key) => str(row[key] ?? schema[key]);
    const values = {
      "{.mediaBaseUrl}": pick(".mediaBaseUrl"),
      "{.fileType}": str(row["File_x0020_Type"] ?? row[".fileType"] ?? schema[".fileType"]),
      "{.callerStack}": pick(".callerStack"),
      "{.spItemUrl}": pick(".spItemUrl"),
      "{.driveAccessToken}": pick(".driveAccessToken")
    };
    let out = template;
    for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
    let u;
    try {
      u = new URL(out);
    } catch {
      return null;
    }
    const set = {
      action: "Access",
      part: "Index",
      format: "dash",
      useScf: "True",
      pretranscode: "0",
      transcodeahead: "0"
    };
    for (const [k, v] of Object.entries(set)) u.searchParams.set(k, v);
    return u.toString();
  }
  function renderListDataUrl(origin, sitePath, listRelativePath) {
    const site = sitePath.replace(/\/$/, "");
    const list = listRelativePath.replace(/'/g, "''");
    return `${origin}${site}/_api/web/GetList(@a1)/RenderListDataAsStream?@a1=${encodeURIComponent(`'${list}'`)}`;
  }
  function sitePathOf(pathname) {
    const m = /^\/(sites|personal|teams)\/[^/]+/i.exec(pathname);
    return m ? m[0] : "";
  }

  // src/lib/directUrl.ts
  function directUrlFromStreamPage(pageUrl) {
    let u;
    try {
      u = new URL(pageUrl);
    } catch {
      return null;
    }
    const id = u.searchParams.get("id");
    if (!id) return null;
    const path = id.startsWith("/") ? id : "/" + id;
    const encoded = path.split("/").map((s) => encodeURIComponent(s)).join("/");
    return `${u.origin}${encoded}?download=1`;
  }

  // src/lib/transcode.ts
  var RE = /\/_api_cached\/v2\.1\/drives\/([^/]+)\/items\/([^/]+)\/oneDrive\.transcode/i;
  function parseTranscodeUrl(url) {
    try {
      const u = new URL(url);
      const m = RE.exec(u.pathname);
      if (!m) return null;
      return { driveId: m[1], itemId: m[2], url: u };
    } catch {
      return null;
    }
  }
  function buildTranscodeUrl(sample, part, track, extra = {}) {
    const u = new URL(sample);
    u.searchParams.set("part", part);
    if (track) u.searchParams.set("track", track);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.toString();
  }
  function decodeBytes(s) {
    const clean = s.trim();
    if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    const bin = atob(clean.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  function parseDecryptionKey(v) {
    let k;
    let iv;
    if (typeof v === "string") [k, iv] = v.split(/[:,]/);
    else if (v && typeof v === "object") {
      const o = v;
      k = o["key"] ?? o["Key"];
      iv = o["iv"] ?? o["IV"] ?? o["Iv"];
    }
    if (!k) return null;
    try {
      const key = decodeBytes(k);
      if (![16, 24, 32].includes(key.length)) return null;
      return { key, iv: iv ? decodeBytes(iv) : new Uint8Array(16) };
    } catch {
      return null;
    }
  }

  // src/lib/transcriptApi.ts
  function withJsonFormat(url) {
    const u = new URL(url);
    u.searchParams.set("format", "json");
    return u.toString();
  }
  function extractTemporaryDownloadUrl(data) {
    let found = null;
    const walk = (v) => {
      if (found || v == null || typeof v !== "object") return;
      const o = v;
      if (typeof o["temporaryDownloadUrl"] === "string") {
        found = o["temporaryDownloadUrl"];
        return;
      }
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(data);
    return found;
  }
  function driveItemTranscriptUrls(origin, sitePath, driveId, itemId) {
    const base = `${origin}${sitePath}/_api/v2.1/drives/${driveId}/items/${itemId}`;
    return [
      `${base}?select=media/transcripts,audioTracks&$expand=media/transcripts,media/audioTracks`,
      `${base}/media/transcripts`
    ];
  }
  function driveItemFromUrl(url) {
    const m = /\/drives\/([^/?#]+)\/items\/([^/?#]+)/i.exec(url);
    return m ? { driveId: decodeURIComponent(m[1]), itemId: decodeURIComponent(m[2]) } : null;
  }

  // src/lib/retry.ts
  var RETRY_STATUS = /* @__PURE__ */ new Set([408, 409, 429]);
  var MAX_ATTEMPTS = 8;
  function shouldRetryStatus(s) {
    return RETRY_STATUS.has(s) || s >= 500 && s <= 599;
  }
  function backoffMs(attempt, retryAfter) {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.max(0, secs * 1e3);
      const d = Date.parse(retryAfter);
      if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
    }
    return Math.min(3e4, 500 * 2 ** attempt);
  }
  var HttpError = class extends Error {
    constructor(status, url) {
      super(`HTTP ${status} for ${url}`);
      this.status = status;
    }
    status;
  };
  async function fetchWithRetry(url, init = {}, deps = {}) {
    const f = deps.fetchFn ?? fetch;
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const max = deps.maxAttempts ?? MAX_ATTEMPTS;
    let last;
    for (let attempt = 0; attempt < max; attempt++) {
      if (deps.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const res = await f(url, { ...init, signal: deps.signal });
        if (res.ok) return res;
        if (!shouldRetryStatus(res.status)) throw new HttpError(res.status, url);
        last = new HttpError(res.status, url);
        if (attempt < max - 1) await sleep(backoffMs(attempt, res.headers.get("Retry-After")));
      } catch (e) {
        if (e instanceof HttpError || e.name === "AbortError") throw e;
        last = e;
        if (attempt < max - 1) await sleep(backoffMs(attempt, null));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  // src/lib/filename.ts
  var RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  var MAX_NAME_LENGTH = 150;
  function sanitizeFilename(name, fallbackId = "unknown") {
    let s = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ");
    s = s.replace(/[. ]+$/, "").replace(/^\s+/, "");
    if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH).replace(/[. ]+$/, "");
    if (!s) return `video_${fallbackId}`;
    const base = s.split(".")[0] ?? s;
    if (RESERVED.test(base)) s = "_" + s;
    return s;
  }
  var p2 = (n) => String(n).padStart(2, "0");
  function applyTemplate(template, t) {
    const now = t.now ?? /* @__PURE__ */ new Date();
    const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const time = `${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
    const map = {
      title: t.title ?? "",
      date,
      time,
      site: t.site ?? "",
      quality: t.quality ?? "",
      id: t.id ?? ""
    };
    const out = (template || "{title}").replace(/\{(\w+)\}/g, (m, k) => k in map ? map[k] : m);
    return sanitizeFilename(out, t.id || "unknown");
  }

  // src/lib/transcript.ts
  function parseOffset(v) {
    if (typeof v === "number") return v > 1e6 ? v / 1e7 : v;
    if (typeof v !== "string") return 0;
    const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v);
    if (iso) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
    const parts = v.split(":").map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((a, p) => a * 60 + p, 0);
  }
  function parseTranscript(json) {
    const obj = json;
    const list = Array.isArray(obj) ? obj : obj?.entries ?? obj?.events ?? [];
    return list.filter((e) => typeof e.text === "string" && e.text.trim() !== "").map((e) => ({
      start: parseOffset(e.startOffset ?? e.startTime),
      end: parseOffset(e.endOffset ?? e.endTime),
      speaker: e.speakerDisplayName ?? e.speaker ?? "",
      text: e.text.trim()
    }));
  }
  function ts(sec, sep) {
    const ms = Math.round(sec * 1e3);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 36e5))}:${p(Math.floor(ms / 6e4) % 60)}:${p(Math.floor(ms / 1e3) % 60)}${sep}${p(ms % 1e3, 3)}`;
  }
  var escVtt = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function toVtt(cues) {
    const body = cues.map((c) => `${ts(c.start, ".")} --> ${ts(c.end, ".")}
${c.speaker ? `<v ${escVtt(c.speaker.replace(/[\n>]/g, " "))}>` : ""}${escVtt(c.text)}`).join("\n\n");
    return `WEBVTT

${body}
`;
  }
  function toSrt(cues) {
    return cues.map((c, i) => `${i + 1}
${ts(c.start, ",")} --> ${ts(c.end, ",")}
${c.speaker ? `${c.speaker}: ` : ""}${c.text}`).join("\n\n") + "\n";
  }
  function toGroupedText(cues, withTimestamps = false) {
    const blocks = [];
    for (const c of cues) {
      const last = blocks[blocks.length - 1];
      if (last && last.speaker === c.speaker) last.texts.push(c.text);
      else blocks.push({ speaker: c.speaker, start: c.start, texts: [c.text] });
    }
    return blocks.map((b) => {
      const stamp = withTimestamps ? `[${ts(b.start, ".").slice(0, 8)}] ` : "";
      return `${stamp}${b.speaker || "Unknown"}:
${b.texts.join(" ")}`;
    }).join("\n\n") + "\n";
  }
  function convertTranscript(json, format, withTimestamps = true) {
    if (format === "json") return JSON.stringify(json, null, 2);
    const cues = parseTranscript(json);
    if (format === "vtt") return toVtt(cues);
    if (format === "srt") return toSrt(cues);
    return toGroupedText(cues, withTimestamps);
  }
  var TRANSCRIPT_EXT = { json: ".json", vtt: ".vtt", txt: ".txt", srt: ".srt" };
  function transcriptSuffix(format, suffixes) {
    return format === "txt" ? suffixes.grouped : suffixes.plain;
  }

  // src/lib/commands.ts
  var TOKEN_WARNING = "This URL contains a short-lived access token. Run the command soon and do not share it.";
  var q = (s) => s.replace(/(["\\$`])/g, "\\$1");
  function ytDlpCommand(manifestUrl, name) {
    return `yt-dlp --no-part -N 4 -o "${q(name)}.mp4" "${q(manifestUrl)}"`;
  }
  function ffmpegCommand(manifestUrl, name) {
    return `ffmpeg -i "${q(manifestUrl)}" -c copy "${q(name)}.mp4"`;
  }

  // src/lib/folderUrl.ts
  var SHARE_RE = /\/:f:\/[a-z]\/[^/?#]+\/[^/?#]+/i;
  function isFolderShareLink(url) {
    try {
      return SHARE_RE.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }
  function folderRefFromUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const id = u.searchParams.get("id");
    const path = id ? id.startsWith("/") ? id : "/" + id : u.pathname;
    if (!id && !/^\/(sites|personal|teams)\//i.test(path)) return null;
    return { origin: u.origin, sitePath: sitePathOf(path), serverRelativePath: path.replace(/\/$/, "") };
  }
  function rel(ref, kind, extra) {
    const p = ref.serverRelativePath.replace(/'/g, "''");
    return `${ref.origin}${ref.sitePath}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(p)}')/${kind}${extra}`;
  }
  var foldersUrl = (ref) => rel(ref, "Folders", "?$select=Name,ServerRelativeUrl,TimeCreated,TimeLastModified");
  var filesUrl = (ref) => rel(ref, "Files", "?$select=Name,ServerRelativeUrl,TimeCreated,TimeLastModified,Length,UniqueId");
  var VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|mpg|mpeg)$/i;
  var isVideoFile = (name) => VIDEO_EXT.test(name);
  function filterAndSortVideos(files, key) {
    const v = files.filter((f) => isVideoFile(f.Name));
    const cmpDate = (a, b) => (Date.parse(a ?? "") || 0) - (Date.parse(b ?? "") || 0);
    return v.sort(
      (a, b) => key === "name" ? a.Name.localeCompare(b.Name, void 0, { numeric: true }) : key === "created" ? cmpDate(a.TimeCreated, b.TimeCreated) : cmpDate(a.TimeLastModified, b.TimeLastModified)
    );
  }
  function streamPageUrl(ref, fileServerRelativeUrl) {
    const site = ref.sitePath || "";
    return `${ref.origin}${site}/_layouts/15/stream.aspx?id=${encodeURIComponent(fileServerRelativeUrl)}`;
  }

  // src/types.ts
  var DEFAULT_SETTINGS = {
    mode: "av",
    quality: "best",
    concurrency: 4,
    template: "{title}",
    subfolder: "",
    useFolderHandle: false,
    retryOnFailure: false,
    preferDirect: true,
    transcriptFormat: "vtt",
    transcriptTimestamps: true,
    transcriptSuffix: "_transcript",
    transcriptGroupedSuffix: "_transcript_grouped",
    captureFallback: false,
    debug: false
  };

  // src/shared/storage.ts
  async function getSettings() {
    const s = await chrome.storage.sync.get(null);
    return { ...DEFAULT_SETTINGS, ...s };
  }
  async function setSettings(patch) {
    await chrome.storage.sync.set(patch);
  }
  function fmtBytes(n) {
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  function fmtEta(s) {
    if (!Number.isFinite(s) || s < 0) return "--:--";
    const h2 = Math.floor(s / 3600);
    const m = Math.floor(s % 3600 / 60);
    const p = (n) => String(n).padStart(2, "0");
    return h2 ? `${h2}:${p(m)}:${p(Math.floor(s % 60))}` : `${p(m)}:${p(Math.floor(s % 60))}`;
  }

  // src/content-ui.ts
  var CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:Segoe UI,system-ui,sans-serif;font-size:13px}
.w{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:6px;align-items:center;padding:8px;border-radius:10px;
 background:var(--bg);color:var(--fg);box-shadow:0 4px 18px rgba(0,0,0,.35);border:1px solid var(--bd)}
:host{--bg:#fff;--fg:#1b1b1b;--bd:#d0d0d0;--ac:#0f6cbd;--mu:#666}
@media (prefers-color-scheme:dark){:host{--bg:#2b2b2b;--fg:#f0f0f0;--bd:#444;--ac:#479ef5;--mu:#aaa}}
button,select,input[type=text]{background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:5px 9px;cursor:pointer}
button.p{background:var(--ac);color:#fff;border-color:var(--ac)}
button:disabled{opacity:.5;cursor:default}
.grp{display:flex}.grp button:first-child{border-top-right-radius:0;border-bottom-right-radius:0}
.grp button:last-child{border-top-left-radius:0;border-bottom-left-radius:0;border-left:0}
.menu{position:absolute;bottom:100%;right:0;margin-bottom:6px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:4px;min-width:220px}
.bd{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:2147483647}
.m{background:var(--bg);color:var(--fg);border-radius:10px;padding:16px;min-width:360px;max-width:560px;max-height:80vh;overflow:auto;border:1px solid var(--bd)}
.m h3{margin:0 0 10px;font-size:15px}.row{display:flex;gap:8px;align-items:center;margin:6px 0}.row.end{justify-content:flex-end}
.mu{color:var(--mu);font-size:12px}.warn{color:#c50f1f}
progress{width:100%}
label.i{display:flex;gap:6px;align-items:center}
`;
  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = String(v);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, String(v));
    }
    e.append(...kids);
    return e;
  }
  function mountUi(deps) {
    let info = null;
    let host = null;
    let root = null;
    let widget = null;
    let modalProgress = null;
    const isFolder = () => isFolderShareLink(location.href) || /onedrive\.aspx/i.test(location.pathname) && !!new URL(location.href).searchParams.get("id") && !/\.[a-z0-9]{2,4}$/i.test(new URL(location.href).searchParams.get("id") ?? "");
    const ensureHost = () => {
      if (root) return root;
      if (!document.documentElement) return null;
      host = h("div", { id: "spvg-host" });
      root = host.attachShadow({ mode: "open" });
      root.append(h("style", {}, CSS));
      document.documentElement.append(host);
      return root;
    };
    const toast = (msg, bad = false) => {
      const r = ensureHost();
      if (!r) return;
      const t = h("div", { class: "w", style: "bottom:80px" }, h("span", { class: bad ? "warn" : "" }, msg));
      r.append(t);
      setTimeout(() => t.remove(), 4500);
    };
    async function baseName() {
      const s = await getSettings();
      const i = deps.getInfo();
      return applyTemplate(s.template, { title: i.title, site: i.site, id: i.fileInfo.itemId?.slice(0, 8) ?? "" });
    }
    async function downloadTranscript(format) {
      try {
        const s = await getSettings();
        const fmt = format ?? s.transcriptFormat;
        const json = await deps.getTranscriptJson();
        const text = convertTranscript(json, fmt, s.transcriptTimestamps);
        const name = await baseName() + transcriptSuffix(fmt, { plain: s.transcriptSuffix, grouped: s.transcriptGroupedSuffix }) + TRANSCRIPT_EXT[fmt];
        await chrome.runtime.sendMessage({ type: "save-text", filename: name, text, mime: { json: "application/json", vtt: "text/vtt", srt: "application/x-subrip", txt: "text/plain" }[fmt], source: location.href });
        toast(`Transcript saved: ${name}`);
      } catch (e) {
        toast(`Transcript failed: ${e.message}`, true);
      }
    }
    function modal(title, body, actions) {
      const r = ensureHost();
      const close = () => bd.remove();
      const bd = h("div", { class: "bd", onclick: (e) => e.target === bd && close() }, h("div", { class: "m" }, h("h3", {}, title), ...body, h("div", { class: "row end" }, ...actions)));
      r.append(bd);
      return { close, el: bd };
    }
    async function enqueue(extra, start) {
      const i = await deps.discover();
      const s = await getSettings();
      const res = await chrome.runtime.sendMessage({
        type: "enqueue",
        start,
        item: { kind: "video", title: i.title, pageUrl: i.pageUrl, site: i.site, mode: s.mode, quality: s.quality, candidates: i.candidates, needsDiscovery: false, ...extra }
      });
      if (res?.error) toast(res.error, true);
      return res?.id;
    }
    async function quickDownload() {
      const i = await deps.discover();
      if (!i.candidates.length) return toast("No stream found yet. Press play on the video and try again.", true);
      const id = await enqueue({}, true);
      if (id) toast("Download started. Progress is shown in the toolbar badge and popup.");
    }
    async function chooseDialog() {
      const i = await deps.discover();
      const s = await getSettings();
      const cand = i.candidates.find((c) => c.kind !== "direct");
      let reps = [];
      const status = h("div", { class: "mu" }, "Reading stream info...");
      const mode = h("select", {}, h("option", { value: "av" }, "Video + audio (.mp4)"), h("option", { value: "video" }, "Video only (.mp4)"), h("option", { value: "audio" }, "Audio only (.m4a)"));
      mode.value = s.mode;
      const quality = h("select", {}, h("option", { value: "best" }, "Best"), h("option", { value: "1080" }, "Up to 1080p"), h("option", { value: "720" }, "Up to 720p"));
      quality.value = ["best", "1080", "720"].includes(s.quality) ? s.quality : "best";
      const box = h("div", {});
      const go = h("button", { class: "p" }, "Download");
      const cancel = h("button", {}, "Close");
      const add = h("button", {}, "Add to queue");
      const m = modal("Download video", [h("div", { class: "row" }, "Mode", mode), h("div", { class: "row" }, "Quality", quality), status, box], [cancel, add, go]);
      cancel.addEventListener("click", m.close);
      if (cand) {
        void chrome.runtime.sendMessage({ type: "inspect", candidate: cand }).then((r) => {
          if (r?.reps) {
            reps = r.reps.filter((x) => x.kind === "video");
            for (const v of reps) quality.append(h("option", { value: v.id }, `Only: ${v.label}`));
            status.textContent = `${reps.length} video quality option(s) found.`;
          } else status.textContent = `Could not read the manifest (${r?.error ?? "unknown error"}). Presets still work.`;
        });
      } else status.textContent = "Direct file download will be used when available.";
      const run = async (start) => {
        const id = await enqueue({ mode: mode.value, quality: quality.value }, start);
        if (!id) return;
        if (!start) {
          toast("Added to queue");
          m.close();
          return;
        }
        go.disabled = add.disabled = true;
        const bar = h("progress", { max: 100, value: 0 });
        const txt = h("div", { class: "mu" }, "Starting...");
        const stop = h("button", { onclick: () => void chrome.runtime.sendMessage({ type: "queue-remove", id }) }, "Cancel download");
        box.replaceChildren(bar, txt, stop);
        modalProgress = { itemId: id, box };
      };
      go.addEventListener("click", () => void run(true));
      add.addEventListener("click", () => void run(false));
    }
    async function commandMenu(kind) {
      const i = await deps.discover();
      const c = i.candidates.find((x) => x.kind !== "direct");
      if (!c) return toast("No manifest URL captured yet.", true);
      if (!confirm(`${TOKEN_WARNING}

Copy the command to the clipboard?`)) return;
      const name = await baseName();
      const cmd = kind === "yt" ? ytDlpCommand(c.url, name) : ffmpegCommand(c.url, name);
      try {
        await navigator.clipboard.writeText(cmd);
        toast("Command copied. " + TOKEN_WARNING);
      } catch {
        prompt("Copy this command:", cmd);
      }
    }
    async function recordFallback() {
      const v = document.querySelector("video");
      if (!v || typeof v.captureStream !== "function") return toast("No playable <video> element found.", true);
      if (!confirm("Real-time recording takes as long as the video itself and the video must keep playing in this tab. Continue?")) return;
      const stream = v.captureStream();
      const name = await baseName() + ".webm";
      let writer = null;
      try {
        const fw = window;
        if (fw.showSaveFilePicker) writer = await (await fw.showSaveFilePicker({ suggestedName: name, types: [{ accept: { "video/webm": [".webm"] } }] })).createWritable();
      } catch {
        return;
      }
      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
      let chain = Promise.resolve();
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        if (writer) chain = chain.then(() => writer.write(e.data));
        else chunks.push(e.data);
      };
      const stopBtn = h("button", { class: "p" }, "Stop recording");
      const m = modal("Recording...", [h("div", { class: "mu" }, "Recording in real time. It ends when the video ends or you press stop.")], [stopBtn]);
      const finish = async () => {
        if (rec.state !== "inactive") rec.stop();
      };
      stopBtn.addEventListener("click", () => void finish());
      v.addEventListener("ended", () => void finish(), { once: true });
      rec.onstop = () => {
        void chain.then(async () => {
          m.close();
          if (writer) await writer.close();
          else {
            const a = h("a", { href: URL.createObjectURL(new Blob(chunks, { type: "video/webm" })), download: name });
            document.body.append(a);
            a.click();
            a.remove();
          }
          toast("Recording saved.");
        });
      };
      rec.start(1e3);
      if (v.paused) void v.play();
    }
    async function folderDialog() {
      let ref = null;
      try {
        let url = location.href;
        if (isFolderShareLink(url)) url = (await fetch(url, { credentials: "include" })).url;
        ref = folderRefFromUrl(url);
      } catch {
      }
      if (!ref) return toast("Could not resolve this folder.", true);
      const r0 = ref;
      const status = h("div", { class: "mu" }, "Loading...");
      const list = h("div", {});
      const recurse = h("input", { type: "checkbox" });
      const sort = h("select", {}, h("option", { value: "name" }, "Name"), h("option", { value: "created" }, "Created"), h("option", { value: "modified" }, "Modified"));
      let files = [];
      const checks = /* @__PURE__ */ new Map();
      const render = () => {
        checks.clear();
        list.replaceChildren(
          ...filterAndSortVideos([...files], sort.value).map((f) => {
            const cb = h("input", { type: "checkbox", checked: true });
            checks.set(f.ServerRelativeUrl, cb);
            return h("label", { class: "i" }, cb, f.Name);
          })
        );
        status.textContent = `${checks.size} video file(s)`;
      };
      const rows = async (u) => {
        const r = await fetchWithRetry(u, { credentials: "include", headers: { Accept: "application/json;odata=nometadata" } }, { maxAttempts: 3 });
        const j = await r.json();
        return j.value ?? j.d?.results ?? [];
      };
      const load = async () => {
        status.textContent = "Loading...";
        files = [];
        const walk = async (ref2, depth) => {
          files.push(...await rows(filesUrl(ref2)));
          if (recurse.checked && depth < 8) {
            for (const f of await rows(foldersUrl(ref2))) if (f["Name"] !== "Forms") await walk({ ...ref2, serverRelativePath: f["ServerRelativeUrl"] }, depth + 1);
          }
        };
        try {
          await walk(r0, 0);
          render();
        } catch (e) {
          status.textContent = `Failed: ${e.message}`;
        }
      };
      const addBtn = h("button", { class: "p" }, "Add selected to queue");
      const close = h("button", {}, "Close");
      const m = modal("Folder videos", [h("div", { class: "row" }, "Sort by", sort, h("label", { class: "i" }, recurse, "Include subfolders")), status, list], [close, addBtn]);
      close.addEventListener("click", m.close);
      sort.addEventListener("change", render);
      recurse.addEventListener("change", () => void load());
      addBtn.addEventListener("click", async () => {
        const s = await getSettings();
        const items = filterAndSortVideos([...files], sort.value).filter((f) => checks.get(f.ServerRelativeUrl)?.checked).map((f) => ({ kind: "video", title: f.Name.replace(/\.[^.]+$/, ""), pageUrl: streamPageUrl(r0, f.ServerRelativeUrl), site: deps.getInfo().site, mode: s.mode, quality: s.quality, needsDiscovery: true }));
        await chrome.runtime.sendMessage({ type: "enqueue-many", items });
        toast(`${items.length} file(s) added to the queue. Start the queue from the popup.`);
        m.close();
      });
      void load();
    }
    function buildWidget() {
      const r = ensureHost();
      if (!r) return;
      widget?.remove();
      const wrap = (label, items) => {
        const menu = h("div", { class: "menu", hidden: true }, ...items.map(([t, fn]) => h("button", { onclick: () => (menu.hidden = true, fn()) }, t)));
        const btn = h("button", { title: label, onclick: () => menu.hidden = !menu.hidden }, "\u25BE");
        return h("div", { style: "position:relative" }, btn, menu);
      };
      const parts = [];
      if (info && info.candidates.length) {
        parts.push(h("div", { class: "grp" }, h("button", { class: "p", onclick: () => void quickDownload() }, "Download"), wrap("Mode and quality", [["Choose mode and quality\u2026", () => void chooseDialog()]])));
      }
      if (info?.hasTranscriptSource) {
        const fmts = ["vtt", "srt", "txt", "json"];
        parts.push(
          h("div", { class: "grp" }, h("button", { onclick: () => void downloadTranscript() }, "Transcript"), wrap("Transcript format", fmts.map((f) => [`Save as .${f}`, () => void setSettings({ transcriptFormat: f }).then(() => downloadTranscript(f))])))
        );
      }
      if (info && info.candidates.length) {
        parts.push(h("button", { onclick: () => void enqueue({}, false).then((id) => id && toast("Added to queue")) }, "Add to queue"));
        parts.push(wrap("More", [["Copy yt-dlp command", () => void commandMenu("yt")], ["Copy ffmpeg command", () => void commandMenu("ff")]]));
      }
      if (isFolder()) parts.push(h("button", { class: "p", onclick: () => void folderDialog() }, "Folder videos\u2026"));
      void getSettings().then((s) => {
        if (s.captureFallback && document.querySelector("video") && widget) widget.append(h("button", { onclick: () => void recordFallback() }, "Record (real-time)"));
      });
      widget = h("div", { class: "w" }, ...parts);
      if (!parts.length) widget.hidden = true;
      r.append(widget);
    }
    let sig = "";
    function addCommandBarButton() {
      if (!info?.hasTranscriptSource || document.getElementById("spvg-cmd")) return;
      const bar = document.querySelector('[data-automationid="CommandBar"], .ms-CommandBar, [role="menubar"]');
      if (!bar) return;
      bar.append(h("button", { id: "spvg-cmd", type: "button", style: "margin:0 4px;padding:4px 10px;cursor:pointer", onclick: () => void downloadTranscript() }, "Download transcript"));
    }
    new MutationObserver(addCommandBarButton).observe(document, { childList: true, subtree: true });
    return {
      update(i) {
        info = i;
        const s = JSON.stringify([i.candidates.map((c) => c.kind), i.hasTranscriptSource, isFolder()]);
        if (s !== sig && (i.candidates.length || i.hasTranscriptSource || isFolder())) {
          sig = s;
          const go = () => buildWidget();
          if (document.documentElement) go();
          else document.addEventListener("DOMContentLoaded", go, { once: true });
        }
        addCommandBarButton();
      },
      progress(p) {
        if (!modalProgress || modalProgress.itemId !== p.itemId) return;
        const bar = modalProgress.box.querySelector("progress");
        const txt = modalProgress.box.querySelector(".mu");
        if (bar) bar.value = p.percent;
        if (txt) txt.textContent = `${p.phase} ${p.percent.toFixed(1)}% \u2022 ${fmtBytes(p.bytes)} \u2022 ${fmtBytes(p.speed)}/s \u2022 ETA ${fmtEta(p.eta)}`;
      },
      done(m) {
        if (!modalProgress || modalProgress.itemId !== m.itemId) return;
        modalProgress.box.replaceChildren(h("div", { class: m.error ? "warn" : "" }, m.error ? `Failed: ${m.error}` : m.cancelled ? "Cancelled." : `Saved ${m.filename ?? ""}`));
        modalProgress = null;
      }
    };
  }

  // src/content.ts
  var st = {
    nonce: "",
    auth: {},
    manifests: /* @__PURE__ */ new Map(),
    lists: [],
    transcriptLists: [],
    fileInfo: {},
    cdnKey: void 0,
    title: "",
    directOk: null
  };
  var toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  function siteName() {
    const m = /^\/(?:sites|personal|teams)\/([^/]+)/i.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : location.hostname.split(".")[0] ?? "";
  }
  function computeInfo() {
    const cands = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (c) => {
      if (!seen.has(c.url)) {
        seen.add(c.url);
        cands.push(c);
      }
    };
    for (const c of st.manifests.values()) add({ ...c, headers: { ...c.headers, ...st.auth } });
    if (st.fileInfo.transformUrl) {
      const u = manifestFromTransformUrl(st.fileInfo.transformUrl, location.href);
      if (u) add({ kind: "filefallback", url: u, headers: { ...st.auth } });
    }
    for (const l of st.lists) {
      const u = buildManifestFromListData(l);
      if (u) add({ kind: "listdata", url: u, headers: { ...st.auth } });
    }
    const aes = parseDecryptionKey(st.cdnKey);
    for (const e of performance.getEntriesByType("resource")) {
      if (parseTranscodeUrl(e.name)) {
        const c = { kind: "transcode", url: buildTranscodeUrl(e.name, "index", null, { format: "dash" }), headers: { ...st.auth } };
        if (aes) c.aes = { key: toHex(aes.key), iv: toHex(aes.iv) };
        add(c);
        break;
      }
    }
    if (st.directOk) {
      const d = directUrlFromStreamPage(location.href);
      if (d) add({ kind: "direct", url: d });
    }
    const driveItem = driveItemFromUrl(st.fileInfo.transformUrl ?? "") ?? driveItemFromUrl(st.fileInfo.spItemUrl ?? "") ?? driveItemFromUrl(cands.map((c) => c.url).join(" "));
    const fileInfo = { ...st.fileInfo };
    if (driveItem) Object.assign(fileInfo, driveItem);
    delete fileInfo.transformUrl;
    delete fileInfo.spItemUrl;
    return {
      pageUrl: location.href,
      origin: location.origin,
      title: (st.fileInfo.displayName || st.title || document.title || "").trim(),
      site: siteName(),
      fileInfo,
      candidates: cands,
      hasTranscriptSource: st.fileInfo.hasTranscripts !== false && (st.transcriptLists.length > 0 || !!driveItem)
    };
  }
  var pushTimer;
  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => {
      const info = computeInfo();
      ui.update(info);
      if (info.candidates.length || info.hasTranscriptSource) void chrome.runtime.sendMessage({ type: "page-info", info }).catch(() => void 0);
    }, 300);
  }
  function onPageMessage(e) {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d["__spvg"] !== true || d["nonce"] !== st.nonce || !st.nonce) return;
    switch (d["kind"]) {
      case "token":
        if (d["authorization"]) st.auth.authorization = String(d["authorization"]);
        if (d["spopactoken"]) st.auth.spopactoken = String(d["spopactoken"]);
        break;
      case "req": {
        const url = String(d["url"]);
        const h2 = d["headers"] ?? {};
        if (h2.authorization) st.auth.authorization = h2.authorization;
        if (h2.spopactoken) st.auth.spopactoken = h2.spopactoken;
        if (isManifestUrl(url)) {
          try {
            const n = normalizeManifestUrl(url);
            st.manifests.set(n, { kind: "manifest", url: n, headers: h2 });
          } catch {
          }
        }
        break;
      }
      case "body": {
        const url = String(d["url"]);
        if (url.includes("transcripts")) st.transcriptLists.push(d["json"]);
        else st.lists.push(d["json"]);
        break;
      }
      case "state": {
        const fi = d["fileInfo"] ?? {};
        st.fileInfo = {
          displayName: typeof fi["displayName"] === "string" ? fi["displayName"] : void 0,
          transformUrl: typeof fi["transformUrl"] === "string" ? fi["transformUrl"] : void 0,
          spItemUrl: typeof fi["spItemUrl"] === "string" ? fi["spItemUrl"] : void 0,
          hasTranscripts: typeof fi["hasTranscripts"] === "boolean" ? fi["hasTranscripts"] : void 0
        };
        st.cdnKey = d["cdnDecryptionKey"];
        st.title = String(d["title"] ?? "");
        break;
      }
      default:
        return;
    }
    schedulePush();
  }
  function readState() {
    if (st.nonce) window.postMessage({ __spvgc: true, kind: "read-state", nonce: st.nonce }, location.origin);
  }
  async function ensureListData() {
    if (st.lists.length || st.manifests.size) return;
    const id = new URL(location.href).searchParams.get("id");
    if (!id) return;
    const sitePath = sitePathOf(id);
    const segs = id.split("/").filter(Boolean);
    const libSegs = sitePath ? sitePath.split("/").filter(Boolean).length + 1 : 1;
    const library = "/" + segs.slice(0, libSegs).join("/");
    const parent = "/" + segs.slice(0, -1).join("/");
    const url = renderListDataUrl(location.origin, sitePath, library);
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const body = {
      parameters: {
        __metadata: { type: "SP.RenderListDataParameters" },
        RenderOptions: 12295,
        ViewXml: `<View Scope="RecursiveAll"><Query><Where><Eq><FieldRef Name="FileRef"/><Value Type="Text">${esc(id)}</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>`,
        FolderServerRelativeUrl: parent
      }
    };
    try {
      const r = await fetchWithRetry(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json;odata=verbose", Accept: "application/json;odata=verbose", ...st.auth.authorization ? { Authorization: st.auth.authorization } : {} },
        body: JSON.stringify(body)
      }, { maxAttempts: 2 });
      st.lists.push(await r.json());
    } catch {
    }
  }
  async function probeDirect() {
    if (st.directOk !== null) return;
    const d = directUrlFromStreamPage(location.href);
    if (!d) {
      st.directOk = false;
      return;
    }
    try {
      const r = await fetch(d, { credentials: "include", headers: { Range: "bytes=0-0" } });
      st.directOk = r.status === 200 || r.status === 206;
      void r.body?.cancel();
    } catch {
      st.directOk = false;
    }
  }
  async function discover() {
    readState();
    await new Promise((r) => setTimeout(r, 150));
    await ensureListData();
    await probeDirect();
    const info = computeInfo();
    ui.update(info);
    return info;
  }
  async function getTranscriptJson() {
    const fetchJson = async (url, auth = false) => {
      const headers = { Accept: "application/json" };
      if (auth && st.auth.authorization) headers["Authorization"] = st.auth.authorization;
      const r = await fetchWithRetry(url, { credentials: "include", headers }, { maxAttempts: 3 });
      return r.json();
    };
    for (const list of st.transcriptLists) {
      const t = extractTemporaryDownloadUrl(list);
      if (t) return fetchJson(withJsonFormat(new URL(t, location.href).toString()));
    }
    if (st.fileInfo.hasTranscripts === false) throw new Error("This video has no transcript.");
    const info = computeInfo();
    const { driveId, itemId } = info.fileInfo;
    if (!driveId || !itemId) throw new Error("Transcript not found: no drive item information on this page.");
    const sitePath = sitePathOf(location.pathname);
    let lastErr = new Error("Transcript not found");
    for (const u of driveItemTranscriptUrls(location.origin, sitePath, driveId, itemId)) {
      try {
        const t = extractTemporaryDownloadUrl(await fetchJson(u, true));
        if (t) return fetchJson(withJsonFormat(new URL(t, location.href).toString()));
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  var ui = mountUi({ discover, getTranscriptJson, getInfo: computeInfo });
  window.addEventListener("message", onPageMessage);
  window.addEventListener("spvg:nonce", ((e) => {
    if (!st.nonce) {
      st.nonce = String(e.detail);
      readState();
    }
  }));
  window.postMessage({ __spvgc: true, kind: "hello" }, location.origin);
  window.dispatchEvent(new CustomEvent("spvg:req"));
  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.type === "discover-now" || msg.type === "reread-page") {
      void discover().then((info) => respond(info));
      return true;
    }
    if (msg.type === "progress") ui.progress(msg.progress);
    if (msg.type === "job-done") ui.done(msg);
    return void 0;
  });
  window.addEventListener("load", () => {
    readState();
    setTimeout(schedulePush, 1e3);
  });
})();
