"use strict";
(() => {
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
  function uniqueName(base, ext, existing) {
    const taken = new Set([...existing].map((e) => e.toLowerCase()));
    let name = `${base}${ext}`;
    for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${base}_${i}${ext}`;
    return name;
  }

  // src/lib/hosts.ts
  var ALLOWED = [/(^|\.)sharepoint\.com$/i, /(^|\.)sharepoint\.com\.mcas\.ms$/i, /(^|\.)svc\.ms$/i, /^teams\.microsoft\.com$/i, /^teams\.cloud\.microsoft$/i, /^teams\.microsoft\.com\.mcas\.ms$/i];
  function isAllowedUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && ALLOWED.some((r) => r.test(u.hostname));
    } catch {
      return false;
    }
  }
  function sanitizeSubfolder(p) {
    return p.split(/[\\/]+/).map((s) => s.replace(/[<>:"|?*\u0000-\u001f]/g, "").replace(/[. ]+$/, "").trim()).filter((s) => s && s !== "." && s !== "..").join("/");
  }

  // src/lib/xml.ts
  var ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  var decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
  function parseXml(src) {
    const root = { name: "#root", attrs: {}, children: [], text: "" };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while (m = re.exec(src)) {
      const top = stack[stack.length - 1];
      if (m[1] !== void 0) top.text += m[1];
      else if (m[2] !== void 0) {
        if (stack.length > 1) stack.pop();
      } else if (m[3] !== void 0) {
        const attrs = {};
        const are = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let a;
        while (a = are.exec(m[4] ?? "")) attrs[a[1].replace(/^.*:/, "")] = decode(a[2] ?? a[3] ?? "");
        const node = { name: m[3].replace(/^.*:/, ""), attrs, children: [], text: "" };
        top.children.push(node);
        if (m[5] !== "/") stack.push(node);
      } else if (m[6] !== void 0) top.text += decode(m[6]);
    }
    const el = root.children[0];
    if (!el) throw new Error("Invalid XML: no root element");
    return el;
  }
  var child = (n, name) => n.children.find((c) => c.name === name);
  var childrenOf = (n, name) => n.children.filter((c) => c.name === name);

  // src/lib/mpd.ts
  function parseIsoDuration(s) {
    if (!s) return 0;
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
    if (!m) return 0;
    return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  }
  function resolveUrl(ref, base) {
    return new URL(ref, base).toString();
  }
  function fill(tpl, vars) {
    return tpl.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (m, k, w) => {
      if (k === "") return "$";
      const v = vars[k];
      if (v === void 0) return m;
      return w ? String(v).padStart(Number(w), "0") : String(v);
    }).replace(/\$\$/g, "$");
  }
  function kindOf(mime, contentType) {
    const s = `${mime} ${contentType}`;
    if (s.includes("video")) return "video";
    if (s.includes("audio")) return "audio";
    return "text";
  }
  function parseMpd(xml, manifestUrl) {
    const mpd = parseXml(xml);
    const total = parseIsoDuration(mpd.attrs["mediaPresentationDuration"]);
    const mpdBase = child(mpd, "BaseURL")?.text.trim();
    const out = [];
    for (const period of childrenOf(mpd, "Period")) {
      const periodDur = parseIsoDuration(period.attrs["duration"]) || total;
      let pBase = manifestUrl;
      if (mpdBase) pBase = resolveUrl(mpdBase, pBase);
      const pb = child(period, "BaseURL")?.text.trim();
      if (pb) pBase = resolveUrl(pb, pBase);
      for (const set of childrenOf(period, "AdaptationSet")) {
        let sBase = pBase;
        const sb = child(set, "BaseURL")?.text.trim();
        if (sb) sBase = resolveUrl(sb, sBase);
        for (const rep of childrenOf(set, "Representation")) {
          const attr = (k) => rep.attrs[k] ?? set.attrs[k];
          const mime = attr("mimeType") ?? "";
          const kind = kindOf(mime, set.attrs["contentType"] ?? "");
          let rBase = sBase;
          const rb = child(rep, "BaseURL")?.text.trim();
          if (rb) rBase = resolveUrl(rb, rBase);
          const id = rep.attrs["id"] ?? "";
          const bandwidth = Number(rep.attrs["bandwidth"] ?? 0);
          const vars = { RepresentationID: id, Bandwidth: bandwidth };
          const tpl = child(rep, "SegmentTemplate") ?? child(set, "SegmentTemplate");
          const list = child(rep, "SegmentList") ?? child(set, "SegmentList");
          let initUrl = "";
          let segments = [];
          if (tpl) {
            const ts = Number(tpl.attrs["timescale"] ?? 1) || 1;
            if (tpl.attrs["initialization"]) initUrl = resolveUrl(fill(tpl.attrs["initialization"], vars), rBase);
            const media = tpl.attrs["media"] ?? "";
            const startNumber = Number(tpl.attrs["startNumber"] ?? 1);
            const tl = child(tpl, "SegmentTimeline");
            if (tl) {
              let t = 0;
              let n = startNumber;
              for (const s of childrenOf(tl, "S")) {
                if (s.attrs["t"] !== void 0) t = Number(s.attrs["t"]);
                const d = Number(s.attrs["d"]);
                const r2 = Number(s.attrs["r"] ?? 0);
                for (let i = 0; i <= r2; i++) {
                  segments.push({ url: resolveUrl(fill(media, { ...vars, Time: t, Number: n }), rBase), duration: d / ts });
                  t += d;
                  n++;
                }
              }
            } else {
              const d = Number(tpl.attrs["duration"] ?? 0);
              if (d > 0) {
                const segDur = d / ts;
                const count = Math.ceil(periodDur / segDur);
                for (let i = 0; i < count; i++)
                  segments.push({
                    url: resolveUrl(fill(media, { ...vars, Number: startNumber + i, Time: i * d }), rBase),
                    duration: Math.min(segDur, periodDur - i * segDur)
                  });
              }
            }
          } else if (list) {
            const ts = Number(list.attrs["timescale"] ?? 1) || 1;
            const d = Number(list.attrs["duration"] ?? 0) / ts;
            const init = child(list, "Initialization");
            if (init?.attrs["sourceURL"]) initUrl = resolveUrl(init.attrs["sourceURL"], rBase);
            segments = childrenOf(list, "SegmentURL").map((s) => ({ url: resolveUrl(s.attrs["media"] ?? "", rBase), duration: d }));
          } else if (rb) {
            segments = [{ url: rBase, duration: periodDur }];
          }
          const r = {
            id,
            kind,
            mimeType: mime,
            codecs: attr("codecs") ?? "",
            bandwidth,
            initUrl,
            segments,
            duration: segments.reduce((a, s) => a + s.duration, 0) || periodDur
          };
          const w = attr("width");
          const h = attr("height");
          const lang = set.attrs["lang"];
          if (w) r.width = Number(w);
          if (h) r.height = Number(h);
          if (lang) r.lang = lang;
          out.push(r);
        }
      }
    }
    return { duration: total || Math.max(0, ...out.map((r) => r.duration)), representations: out };
  }
  function describeRepresentation(r) {
    const res = r.height ? `${r.width ?? "?"}x${r.height} ` : "";
    return `${res}${Math.round(r.bandwidth / 1e3)} kbps ${r.codecs}`.trim();
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
    const sleep2 = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const max = deps.maxAttempts ?? MAX_ATTEMPTS;
    let last;
    for (let attempt = 0; attempt < max; attempt++) {
      if (deps.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        const res = await f(url, { ...init, signal: deps.signal });
        if (res.ok) return res;
        if (!shouldRetryStatus(res.status)) throw new HttpError(res.status, url);
        last = new HttpError(res.status, url);
        if (attempt < max - 1) await sleep2(backoffMs(attempt, res.headers.get("Retry-After")));
      } catch (e) {
        if (e instanceof HttpError || e.name === "AbortError") throw e;
        last = e;
        if (attempt < max - 1) await sleep2(backoffMs(attempt, null));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
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
  async function addHistory(e) {
    const { history = [] } = await chrome.storage.local.get("history");
    history.unshift(e);
    await chrome.storage.local.set({ history: history.slice(0, 500) });
  }

  // src/background.ts
  var tabStates = /* @__PURE__ */ new Map();
  var progressPct = null;
  var pollTimer;
  var lock = Promise.resolve();
  function withLock(fn) {
    const p = lock.then(fn, fn);
    lock = p.catch(() => void 0);
    return p;
  }
  var readQueue = async () => (await chrome.storage.local.get("queue")).queue ?? [];
  var writeQueue = (queue) => chrome.storage.local.set({ queue });
  var isRunning = async () => !!(await chrome.storage.local.get("queueRunning")).queueRunning;
  var getActive = async () => (await chrome.storage.session.get("active")).active ?? null;
  var setActive = (active) => active ? chrome.storage.session.set({ active }) : chrome.storage.session.remove("active");
  async function mutateItem(id, fn) {
    return withLock(async () => {
      const q = await readQueue();
      const it = q.find((x) => x.id === id);
      if (!it) return void 0;
      fn(it);
      await writeQueue(q);
      return it;
    });
  }
  async function dlog(level, msg) {
    const s = await getSettings();
    if (!s.debug) return;
    const { debugLog = [] } = await chrome.storage.local.get("debugLog");
    debugLog.push(`${(/* @__PURE__ */ new Date()).toISOString()} [${level}] ${msg}`);
    await chrome.storage.local.set({ debugLog: debugLog.slice(-500) });
  }
  async function persistTabs() {
    await chrome.storage.session.set({ tabStates: Object.fromEntries(tabStates) });
  }
  function streamsOf(tabId) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const f of Object.values(tabStates.get(tabId)?.frames ?? {})) for (const c of f.candidates) if (c.kind !== "direct" && !seen.has(c.url)) seen.add(c.url), out.push(c);
    return out;
  }
  function renderBadge(tabId) {
    const text = progressPct !== null ? `${Math.round(progressPct)}%` : streamsOf(tabId).length ? String(streamsOf(tabId).length) : "";
    void chrome.action.setBadgeBackgroundColor({ tabId, color: progressPct !== null ? "#0f6cbd" : "#107c10" }).catch(() => void 0);
    void chrome.action.setBadgeText({ tabId, text }).catch(() => void 0);
  }
  function renderAllBadges() {
    for (const id of tabStates.keys()) renderBadge(id);
    void chrome.action.setBadgeBackgroundColor({ color: "#0f6cbd" });
    void chrome.action.setBadgeText({ text: progressPct !== null ? `${Math.round(progressPct)}%` : "" });
  }
  function cleanCandidates(c) {
    return (c ?? []).filter((x) => isAllowedUrl(x.url));
  }
  function qualityToken(q) {
    return q === "best" ? "best" : /^\d+$/.test(q) ? `${q}p` : q;
  }
  async function enqueueItems(partials, sender) {
    const s = await getSettings();
    const items = [];
    for (const p of partials) {
      if (!isAllowedUrl(p.pageUrl)) return { error: "This URL is not on a supported SharePoint/Teams host." };
      const candidates = cleanCandidates(p.candidates);
      items.push({
        id: crypto.randomUUID(),
        kind: p.kind ?? "video",
        title: p.title ?? "",
        pageUrl: p.pageUrl,
        site: p.site ?? "",
        mode: p.mode ?? s.mode,
        quality: p.quality ?? s.quality,
        status: "queued",
        needsDiscovery: p.needsDiscovery ?? candidates.length === 0,
        candidates,
        tabId: p.tabId ?? sender?.tab?.id,
        frameId: p.frameId ?? sender?.frameId,
        attempts: 0,
        addedAt: Date.now()
      });
    }
    await withLock(async () => {
      const q = await readQueue();
      const active = q.filter((i) => i.status === "queued" || i.status === "running");
      const rest = q.filter((i) => !(i.status === "queued" || i.status === "running"));
      await writeQueue([...active, ...items, ...rest]);
    });
    return items.map((i) => i.id);
  }
  async function setRunning(on) {
    await chrome.storage.local.set({ queueRunning: on });
    if (on) void pump();
  }
  var pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      if (!await isRunning() || await getActive()) return;
      const item = await withLock(async () => {
        const q = await readQueue();
        if (q.some((i) => i.status === "running")) return void 0;
        const next = q.find((i) => i.status === "queued");
        if (next) {
          next.status = "running";
          next.error = void 0;
          await writeQueue(q);
        }
        return next;
      });
      if (!item) {
        progressPct = null;
        renderAllBadges();
        return;
      }
      await setActive({ kind: "prep", itemId: item.id });
      void startItem(item);
    } finally {
      pumping = false;
    }
  }
  async function finishItem(id, outcome) {
    await setActive(null);
    clearInterval(pollTimer);
    const s = await getSettings();
    await withLock(async () => {
      const q = await readQueue();
      const i = q.findIndex((x) => x.id === id);
      if (i < 0) return;
      const it2 = q[i];
      if (outcome.cancelled) q.splice(i, 1);
      else if (outcome.error) {
        it2.attempts++;
        it2.error = outcome.error;
        if (s.retryOnFailure && it2.attempts < 3) {
          it2.status = "queued";
          q.splice(i, 1);
          q.push(it2);
        } else it2.status = "error";
      } else {
        it2.status = "done";
        it2.outputName = outcome.filename;
        q.splice(i, 1);
        q.push(it2);
      }
      await writeQueue(q);
    });
    const it = (await readQueue()).find((x) => x.id === id);
    if (it?.tabId !== void 0) void chrome.tabs.sendMessage(it.tabId, { type: "job-done", itemId: id, filename: outcome.filename, error: outcome.error, cancelled: outcome.cancelled, sinkKind: "opfs" }).catch(() => void 0);
    progressPct = null;
    renderAllBadges();
    await dlog(outcome.error ? "error" : "info", `Item ${id} finished: ${outcome.error ?? outcome.cancelled ? outcome.error ?? "cancelled" : outcome.filename}`);
    void pump();
  }
  async function sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }
  async function tabAlive(id) {
    if (id === void 0) return false;
    try {
      await chrome.tabs.get(id);
      return true;
    } catch {
      return false;
    }
  }
  async function discoverInNewTab(url, timeoutMs = 6e4) {
    const tab = await chrome.tabs.create({ url, active: false });
    const id = tab.id;
    try {
      const t0 = Date.now();
      let frameId = -1;
      while (Date.now() - t0 < timeoutMs) {
        await sleep(1e3);
        const fr = Object.entries(tabStates.get(id)?.frames ?? {}).find(([, f]) => f.candidates.length > 0);
        if (fr) {
          frameId = Number(fr[0]);
          break;
        }
      }
      if (frameId < 0) frameId = 0;
      return await new Promise((resolve) => {
        chrome.tabs.sendMessage(id, { type: "discover-now" }, { frameId }, (r) => resolve(chrome.runtime.lastError ? null : r ?? null));
      });
    } finally {
      await chrome.tabs.remove(id).catch(() => void 0);
      tabStates.delete(id);
    }
  }
  async function freshInfo(item, forceNew) {
    if (!forceNew && item.needsDiscovery === false && item.candidates.length && await tabAlive(item.tabId)) return null;
    if (item.tabId !== void 0 && await tabAlive(item.tabId)) {
      const info = await new Promise((resolve) => {
        chrome.tabs.sendMessage(item.tabId, { type: "reread-page" }, { frameId: item.frameId ?? 0 }, (r) => resolve(chrome.runtime.lastError ? null : r ?? null));
      });
      const old = new Set(item.candidates.map((c) => c.url));
      if (info && info.candidates.some((c) => c.kind !== "direct" && !old.has(c.url))) return info;
    }
    return discoverInNewTab(item.pageUrl);
  }
  async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS], justification: "Download, decrypt and mux video segments off the service worker" });
  }
  async function existingNames(subfolder, base) {
    const names = [];
    const found = await chrome.downloads.search({ query: [base], exists: true, limit: 1e3 }).catch(() => []);
    for (const d of found) names.push(d.filename.split(/[\\/]/).pop() ?? "");
    const { history = [] } = await chrome.storage.local.get("history");
    for (const h of history) if (h.filename.startsWith(subfolder ? `${subfolder}/` : "")) names.push(h.filename.split("/").pop() ?? "");
    return names;
  }
  async function outputPath(base, ext, s) {
    const sub = sanitizeSubfolder(s.subfolder);
    const name = uniqueName(base, ext, await existingNames(sub, base));
    return sub ? `${sub}/${name}` : name;
  }
  async function startItem(item) {
    try {
      const s = await getSettings();
      let it = item;
      if (it.needsDiscovery || !it.candidates.length) {
        const info = await discoverInNewTab(it.pageUrl);
        if (!info || !info.candidates.length) throw new Error("No stream could be discovered for this page.");
        it = await mutateItem(it.id, (x) => {
          x.candidates = cleanCandidates(info.candidates);
          x.needsDiscovery = false;
          x.title ||= info.title;
          x.site ||= info.site;
        });
      }
      if (!(await withLock(readQueue)).some((x) => x.id === it.id && x.status === "running")) return;
      const itemIdShort = it.id.slice(0, 8);
      const base = applyTemplate(s.template, { title: it.title, site: it.site, quality: qualityToken(it.quality), id: itemIdShort });
      const direct = it.candidates.find((c) => c.kind === "direct");
      if (direct && s.preferDirect && it.mode === "av" && it.quality === "best") {
        const ext2 = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(new URL(direct.url).pathname)?.[1] ?? "mp4";
        const filename = await outputPath(base, `.${ext2.toLowerCase()}`, s);
        const downloadId = await chrome.downloads.download({ url: direct.url, filename, conflictAction: "uniquify" });
        await setActive({ kind: "direct", itemId: it.id, downloadId });
        watchDownload(it.id, downloadId, filename, true);
        return;
      }
      const mode = it.mode;
      const ext = mode === "audio" ? ".m4a" : ".mp4";
      await ensureOffscreen();
      await setActive({ kind: "offscreen", itemId: it.id, base, ext });
      await chrome.runtime.sendMessage({
        target: "offscreen",
        cmd: "start",
        spec: { itemId: it.id, candidates: cleanCandidates(it.candidates), mode, quality: it.quality, concurrency: s.concurrency },
        base,
        useFolder: s.useFolderHandle
      });
    } catch (e) {
      await finishItem(item.id, { error: e.message });
    }
  }
  function watchDownload(itemId, downloadId, filename, report) {
    clearInterval(pollTimer);
    const check = async () => {
      const [d] = await chrome.downloads.search({ id: downloadId });
      if (!d) return;
      if (report && d.state === "in_progress") {
        const pct = d.totalBytes > 0 ? d.bytesReceived / d.totalBytes * 100 : 0;
        onProgress({ itemId, percent: pct, bytes: d.bytesReceived, speed: 0, eta: Infinity, phase: "Downloading" });
      }
      if (d.state === "complete") await onSaved(itemId, downloadId, d.filename ? filename : filename);
      else if (d.state === "interrupted") await onSaveFailed(itemId, downloadId, d.error ?? "interrupted");
    };
    pollTimer = setInterval(() => void check(), 1e3);
  }
  var claimed = /* @__PURE__ */ new Set();
  async function onSaved(itemId, downloadId, filename) {
    const a = await getActive();
    if (!a || a.itemId !== itemId || claimed.has(itemId)) return;
    claimed.add(itemId);
    clearInterval(pollTimer);
    const it = (await readQueue()).find((x) => x.id === itemId);
    await addHistory({ ts: Date.now(), filename, source: it?.pageUrl ?? "" });
    if (a.kind === "save") void chrome.runtime.sendMessage({ target: "offscreen", cmd: "cleanup", itemId }).catch(() => void 0);
    void downloadId;
    await finishItem(itemId, { filename });
  }
  async function onSaveFailed(itemId, _downloadId, error) {
    if (claimed.has(itemId)) return;
    claimed.add(itemId);
    clearInterval(pollTimer);
    void chrome.runtime.sendMessage({ target: "offscreen", cmd: "cleanup", itemId }).catch(() => void 0);
    await finishItem(itemId, { error: `Saving failed: ${error}` });
  }
  function onProgress(p) {
    progressPct = p.percent;
    renderAllBadges();
    void chrome.storage.session.set({ progress: p });
    void readQueue().then((q) => {
      const tab = q.find((x) => x.id === p.itemId)?.tabId;
      if (tab !== void 0) void chrome.tabs.sendMessage(tab, { type: "progress", progress: p }).catch(() => void 0);
    });
  }
  async function handleJobDone(m) {
    const a = await getActive();
    if (!a || a.itemId !== m.itemId || a.kind !== "offscreen") return;
    if (m.cancelled) return finishItem(m.itemId, { cancelled: true });
    if (m.error) return finishItem(m.itemId, { error: m.error });
    const s = await getSettings();
    if (m.sinkKind === "folder") {
      const it = (await readQueue()).find((x) => x.id === m.itemId);
      await addHistory({ ts: Date.now(), filename: m.filename ?? a.base + a.ext, source: it?.pageUrl ?? "" });
      return finishItem(m.itemId, { filename: m.filename });
    }
    const filename = await outputPath(a.base, a.ext, s);
    try {
      const downloadId = await chrome.downloads.download({ url: m.blobUrl, filename, conflictAction: "uniquify" });
      await setActive({ kind: "save", itemId: m.itemId, downloadId });
      watchDownload(m.itemId, downloadId, filename, false);
    } catch (e) {
      await finishItem(m.itemId, { error: `Saving failed: ${e.message}` });
    }
  }
  async function cancelItem(id) {
    const a = await getActive();
    if (a && a.itemId === id) {
      if (a.kind === "offscreen") {
        void chrome.runtime.sendMessage({ target: "offscreen", cmd: "cancel", itemId: id }).catch(() => void 0);
        return;
      }
      if (a.kind === "direct" || a.kind === "save") {
        await chrome.downloads.cancel(a.downloadId).catch(() => void 0);
        await chrome.downloads.removeFile(a.downloadId).catch(() => void 0);
      }
      await finishItem(id, { cancelled: true });
      return;
    }
    await withLock(async () => writeQueue((await readQueue()).filter((x) => x.id !== id)));
  }
  async function saveText(m) {
    const s = await getSettings();
    const dot = m.filename.lastIndexOf(".");
    const base = dot > 0 ? m.filename.slice(0, dot) : m.filename;
    const ext = dot > 0 ? m.filename.slice(dot) : "";
    const filename = await outputPath(base, ext, s);
    const url = `data:${m.mime};charset=utf-8,${encodeURIComponent(m.text)}`;
    await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
    await addHistory({ ts: Date.now(), filename, source: m.source });
    return { filename };
  }
  async function inspect(c) {
    if (!isAllowedUrl(c.url)) return { error: "blocked host" };
    try {
      const h = {};
      if (c.headers?.authorization) h["Authorization"] = c.headers.authorization;
      if (c.headers?.spopactoken) h["x-spopactoken"] = c.headers.spopactoken;
      const r = await fetchWithRetry(c.url, { credentials: "include", headers: h }, { maxAttempts: 3 });
      const mpd = parseMpd(await r.text(), c.url);
      return { reps: mpd.representations.map((x) => ({ id: x.id, kind: x.kind, label: describeRepresentation(x), height: x.height, bandwidth: x.bandwidth })) };
    } catch (e) {
      return { error: e.message };
    }
  }
  var ready = (async () => {
    const { tabStates: saved } = await chrome.storage.session.get("tabStates");
    for (const [k, v] of Object.entries(saved ?? {})) tabStates.set(Number(k), v);
    const a = await getActive();
    let alive = false;
    if (a?.kind === "offscreen") {
      alive = await chrome.offscreen.hasDocument() && !!await chrome.runtime.sendMessage({ target: "offscreen", cmd: "has", itemId: a.itemId }).catch(() => false);
    } else if (a?.kind === "direct" || a?.kind === "save") {
      const [d] = await chrome.downloads.search({ id: a.downloadId });
      alive = d?.state === "in_progress";
      if (alive) watchDownload(a.itemId, a.downloadId, d.filename, a.kind === "direct");
    }
    if (!alive) {
      await setActive(null);
      await withLock(async () => {
        const q = await readQueue();
        for (const i of q) if (i.status === "running") i.status = "queued";
        await writeQueue(q);
      });
    }
    void pump();
  })();
  chrome.runtime.onInstalled.addListener((d) => {
    chrome.contextMenus.create({
      id: "spvg-link",
      title: "Download with SP Video Grabber",
      contexts: ["link"],
      targetUrlPatterns: ["https://*.sharepoint.com/*", "https://*.sharepoint.com.mcas.ms/*", "https://teams.microsoft.com/*", "https://teams.cloud.microsoft/*", "https://teams.microsoft.com.mcas.ms/*"]
    });
    if (d.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#welcome") });
  });
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId !== "spvg-link" || !info.linkUrl) return;
    void ready.then(async () => {
      const r = await enqueueItems([{ pageUrl: info.linkUrl, needsDiscovery: true }]);
      if (!("error" in r)) await setRunning(true);
    });
  });
  chrome.tabs.onRemoved.addListener((id) => {
    tabStates.delete(id);
    void persistTabs();
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status === "loading" && tabStates.delete(id)) {
      void persistTabs();
      renderBadge(id);
    }
  });
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state) return;
    void ready.then(async () => {
      const a = await getActive();
      if (!a || a.kind !== "save" && a.kind !== "direct" || a.downloadId !== delta.id) return;
      const [d] = await chrome.downloads.search({ id: delta.id });
      if (!d) return;
      const rel = d.filename.replace(/\\/g, "/");
      const s = await getSettings();
      const sub = sanitizeSubfolder(s.subfolder);
      const shown = sub && rel.includes(`/${sub}/`) ? rel.slice(rel.lastIndexOf(`/${sub}/`) + 1) : rel.split("/").pop() ?? rel;
      if (delta.state?.current === "complete") await onSaved(a.itemId, a.downloadId, shown);
      else if (delta.state?.current === "interrupted") await onSaveFailed(a.itemId, a.downloadId, d.error ?? "interrupted");
    });
  });
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    if (raw.target === "offscreen") return void 0;
    const m = raw;
    const run = async () => {
      await ready;
      switch (m.type) {
        case "page-info": {
          const tabId = sender.tab?.id;
          if (tabId === void 0) return;
          const st = tabStates.get(tabId) ?? { frames: {} };
          st.frames[sender.frameId ?? 0] = { ...m.info, candidates: cleanCandidates(m.info.candidates) };
          tabStates.set(tabId, st);
          await persistTabs();
          renderBadge(tabId);
          return;
        }
        case "get-tab-state":
          return { frames: tabStates.get(m.tabId)?.frames ?? {} };
        case "enqueue": {
          const r = await enqueueItems([m.item], sender);
          if ("error" in r) return r;
          if (m.start) await setRunning(true);
          return { id: r[0] };
        }
        case "enqueue-many": {
          const r = await enqueueItems(m.items, sender);
          return "error" in r ? r : { ids: r };
        }
        case "queue-get":
          return { queue: await readQueue(), running: await isRunning() };
        case "queue-remove":
          return cancelItem(m.id);
        case "queue-move":
          return withLock(async () => {
            const q = await readQueue();
            const i = q.findIndex((x) => x.id === m.id);
            const j = i + m.delta;
            if (i < 0 || j < 0 || j >= q.length) return;
            const [it] = q.splice(i, 1);
            q.splice(j, 0, it);
            await writeQueue(q);
          });
        case "queue-retry":
          await mutateItem(m.id, (i) => {
            i.status = "queued";
            i.error = void 0;
          });
          return void pump();
        case "queue-clear-finished":
          return withLock(async () => writeQueue((await readQueue()).filter((i) => i.status === "queued" || i.status === "running")));
        case "queue-start":
          return setRunning(true);
        case "queue-stop":
          await chrome.storage.local.set({ queueRunning: false });
          return;
        case "inspect":
          return inspect(m.candidate);
        case "save-text":
          return saveText(m);
        case "log":
          return dlog(m.level, m.msg);
        case "progress":
          return onProgress(m.progress);
        case "job-done":
          return handleJobDone(m);
        case "refresh": {
          const it = (await readQueue()).find((x) => x.id === m.itemId);
          if (!it) return null;
          const info = await freshInfo(it, true);
          if (!info) return null;
          const c = cleanCandidates(info.candidates);
          await mutateItem(it.id, (x) => x.candidates = c);
          return c;
        }
        default:
          return void 0;
      }
    };
    run().then(respond, (e) => respond({ error: e.message }));
    return true;
  });
  chrome.runtime.onStartup.addListener(() => void ready);
})();
