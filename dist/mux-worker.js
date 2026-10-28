"use strict";
(() => {
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
  function pickVideo(reps, preset) {
    const v = reps.filter((r) => r.kind === "video");
    if (typeof preset === "object") return v.find((r) => r.id === preset.id);
    const cap = preset === "best" ? Infinity : Number(preset);
    const byQuality = (a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth;
    const ok = v.filter((r) => (r.height ?? 0) <= cap).sort(byQuality);
    return ok[0] ?? [...v].sort(byQuality).pop();
  }
  function pickAudio(reps) {
    return reps.filter((r) => r.kind === "audio").sort((a, b) => b.bandwidth - a.bandwidth)[0];
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

  // src/lib/fmp4.ts
  function readBoxes(buf, start = 0, end = buf.length) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      let header = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) size = end - p;
      if (size < header || p + size > end) break;
      out.push({ type, start: p, end: p + size, header });
      p += size;
    }
    return out;
  }
  var find = (buf, boxes, t) => boxes.find((b) => b.type === t);
  var inner = (buf, b) => readBoxes(buf, b.start + b.header, b.end);
  function box(type, ...parts) {
    const len = parts.reduce((a, p) => a + p.length, 8);
    const out = new Uint8Array(len);
    new DataView(out.buffer).setUint32(0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  var u32 = (...v) => {
    const a = new Uint8Array(v.length * 4);
    const dv = new DataView(a.buffer);
    v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0));
    return a;
  };
  function readInit(init) {
    const top = readBoxes(init);
    const moov = find(init, top, "moov");
    if (!moov) throw new Error("init segment has no moov");
    const mb = inner(init, moov);
    const trakBox = find(init, mb, "trak");
    if (!trakBox) throw new Error("init segment has no trak");
    const tb = inner(init, trakBox);
    const tkhd = find(init, tb, "tkhd");
    const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
    const tkhdVer = init[tkhd.start + 8];
    const trackId = dv.getUint32(tkhd.start + (tkhdVer === 1 ? 28 : 20));
    const mdia = find(init, tb, "mdia");
    const mdhd = find(init, inner(init, mdia), "mdhd");
    const mdhdVer = init[mdhd.start + 8];
    const timescale = dv.getUint32(mdhd.start + (mdhdVer === 1 ? 28 : 20));
    const mvex = find(init, mb, "mvex");
    const trexBox = mvex ? find(init, inner(init, mvex), "trex") : void 0;
    const trex = trexBox ? init.slice(trexBox.start, trexBox.end) : box("trex", u32(0, trackId, 1, 0, 0, 0));
    return { trackId, timescale, trak: init.slice(trakBox.start, trakBox.end), trex };
  }
  function processSegment(seg, newTrackId, sequence, defaultDuration = 0) {
    const out = new Uint8Array(seg.length);
    let w = 0;
    let info = null;
    const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
    const top = readBoxes(seg);
    let seq = sequence;
    for (const b of top) {
      if (b.type !== "moof" && b.type !== "mdat") continue;
      const start = w;
      out.set(seg.subarray(b.start, b.end), w);
      w += b.end - b.start;
      if (b.type !== "moof") continue;
      const odv = new DataView(out.buffer);
      const rel = (x) => x - b.start + start;
      for (const m of readBoxes(seg, b.start + b.header, b.end)) {
        if (m.type === "mfhd") odv.setUint32(rel(m.start) + 12, seq++);
        if (m.type !== "traf") continue;
        let defDur = defaultDuration;
        let baseTime = 0;
        let dur = 0;
        for (const t of readBoxes(seg, m.start + m.header, m.end)) {
          const o = t.start + 8;
          if (t.type === "tfhd") {
            odv.setUint32(rel(t.start) + 12, newTrackId);
            const flags = dv.getUint32(o) & 16777215;
            let q = o + 8;
            if (flags & 1) q += 8;
            if (flags & 2) q += 4;
            if (flags & 8) defDur = dv.getUint32(q);
          } else if (t.type === "tfdt") {
            baseTime = seg[o] === 1 ? Number(dv.getBigUint64(o + 4)) : dv.getUint32(o + 4);
          } else if (t.type === "trun") {
            const flags = dv.getUint32(o) & 16777215;
            const count = dv.getUint32(o + 4);
            let q = o + 8;
            if (flags & 1) q += 4;
            if (flags & 4) q += 4;
            const per = (flags & 256 ? 4 : 0) + (flags & 512 ? 4 : 0) + (flags & 1024 ? 4 : 0) + (flags & 2048 ? 4 : 0);
            for (let i = 0; i < count; i++) {
              dur += flags & 256 ? dv.getUint32(q + i * per) : defDur;
            }
          }
        }
        info = { trackId: newTrackId, baseTime, duration: dur };
      }
    }
    return { bytes: out.slice(0, w), info };
  }
  var Fmp4Muxer = class {
    tracks = [];
    seq = 1;
    headerBytes;
    durOffset = 0;
    mehdOffset = 0;
    constructor(tracks) {
      tracks.forEach((t, i) => {
        const info = readInit(t.init);
        this.tracks.push({ ...info, newId: i + 1, end: 0 });
      });
      const audioOnly = tracks.every((t) => t.kind === "audio");
      const enc = (s) => new TextEncoder().encode(s);
      const brand = audioOnly ? "M4A " : "isom";
      const ftyp = box("ftyp", enc(brand), u32(0), enc("isom"), enc("iso6"), enc("mp41"));
      const mvhd = box(
        "mvhd",
        u32(0, 0, 0, 1e3, 0, 65536),
        new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        u32(65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824),
        u32(0, 0, 0, 0, 0, 0),
        u32(this.tracks.length + 1)
      );
      const mehd = box("mehd", u32(0, 0));
      const traks = [];
      const trexes = [];
      for (const t of this.tracks) {
        const trak = t.trak.slice();
        const tb = readBoxes(trak, 8, trak.length);
        const tkhd = tb.find((b) => b.type === "tkhd");
        new DataView(trak.buffer).setUint32(tkhd.start + (trak[tkhd.start + 8] === 1 ? 28 : 20), t.newId);
        traks.push(trak);
        const trex = t.trex.slice();
        new DataView(trex.buffer).setUint32(12, t.newId);
        trexes.push(trex);
      }
      const mvex = box("mvex", mehd, ...trexes);
      const moov = box("moov", mvhd, ...traks, mvex);
      const hdr = new Uint8Array(ftyp.length + moov.length);
      hdr.set(ftyp, 0);
      hdr.set(moov, ftyp.length);
      this.headerBytes = hdr;
      const mvhdPos = ftyp.length + 8;
      this.durOffset = mvhdPos + 8 + 16;
      this.mehdOffset = mvhdPos + mvhd.length + traks.reduce((a, t) => a + t.length, 0) + 8 + 8 + 4;
    }
    header() {
      return this.headerBytes;
    }
    /** Rewritten fragment for track index `i`. */
    fragment(i, seg) {
      const t = this.tracks[i];
      const { bytes, info } = processSegment(seg, t.newId, this.seq);
      this.seq += 1;
      if (info) t.end = Math.max(t.end, (info.baseTime + info.duration) / t.timescale);
      return bytes;
    }
    durationSeconds() {
      return Math.max(0, ...this.tracks.map((t) => t.end));
    }
    /** Patches to apply to the already-written header once the duration is known. */
    durationPatches() {
      const ms = Math.round(this.durationSeconds() * 1e3);
      return [
        { offset: this.durOffset, bytes: u32(ms) },
        { offset: this.mehdOffset, bytes: u32(ms) }
      ];
    }
  };

  // src/lib/transcode.ts
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

  // src/engine/download.ts
  function hdrs(h) {
    const o = {};
    if (h?.authorization) o["Authorization"] = h.authorization;
    if (h?.spopactoken) o["x-spopactoken"] = h.spopactoken;
    return o;
  }
  function presetOf(q) {
    return q === "best" || q === "1080" || q === "720" ? q : { id: q };
  }
  function choose(mpd, mode, quality) {
    const out = [];
    if (mode !== "audio") {
      const v = pickVideo(mpd.representations, presetOf(quality)) ?? pickVideo(mpd.representations, "best");
      if (v) out.push({ rep: v, kind: "video", segments: v.segments });
    }
    if (mode !== "video") {
      const a = pickAudio(mpd.representations);
      if (a) out.push({ rep: a, kind: "audio", segments: a.segments });
    }
    if (!out.length) throw new Error(`The manifest has no ${mode === "audio" ? "audio" : "video"} track.`);
    return out;
  }
  async function runDownload(spec, base, hooks) {
    const { signal } = hooks;
    let cand;
    let mpd;
    let lastErr;
    const loadMpd = async (c) => {
      const r = await fetchWithRetry(c.url, { credentials: "include", headers: hdrs(c.headers) }, { signal });
      const m = parseMpd(await r.text(), c.url);
      if (!m.representations.length) throw new Error("Manifest contained no representations");
      return m;
    };
    for (const c of spec.candidates) {
      if (c.kind === "direct") continue;
      try {
        mpd = await loadMpd(c);
        cand = c;
        break;
      } catch (e) {
        lastErr = e;
        hooks.log(`Candidate ${c.kind} failed: ${e.message}`);
        if (signal.aborted) throw e;
      }
    }
    if (!cand || !mpd) throw lastErr instanceof Error ? lastErr : new Error("No usable stream manifest found.");
    const active = { cand, mpd };
    const tracks = choose(mpd, spec.mode, spec.quality);
    let aesKey = null;
    let aesIv = null;
    if (cand.aes) {
      aesKey = await crypto.subtle.importKey("raw", decodeBytes(cand.aes.key), "AES-CBC", false, ["decrypt"]);
      aesIv = decodeBytes(cand.aes.iv);
    }
    let refreshing = null;
    const refresh = () => {
      refreshing ??= (async () => {
        hooks.log("Token appears to have expired; re-reading the page");
        const fresh = await hooks.refresh();
        if (!fresh?.length) throw new Error("Session expired and the manifest could not be refreshed.");
        let m;
        let used;
        for (const c of fresh) {
          if (c.kind === "direct") continue;
          try {
            m = await loadMpd(c);
            used = c;
            break;
          } catch {
          }
        }
        if (!m || !used) throw new Error("Refreshed manifest could not be loaded.");
        for (const t of tracks) {
          const same = m.representations.find((r) => r.id === t.rep.id && r.kind === t.kind) ?? m.representations.find((r) => r.kind === t.kind && r.bandwidth === t.rep.bandwidth);
          if (same && same.segments.length === t.segments.length) t.segments = same.segments;
        }
        active.cand = used;
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    };
    let bytes = 0;
    const samples = [];
    const get = async (urlOf) => {
      for (let refreshes = 0; ; refreshes++) {
        try {
          const r = await fetchWithRetry(urlOf(), { credentials: "include", headers: hdrs(active.cand.headers) }, { signal });
          let buf = new Uint8Array(await r.arrayBuffer());
          bytes += buf.length;
          if (aesKey && aesIv) buf = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: aesIv }, aesKey, buf));
          return buf;
        } catch (e) {
          if (e instanceof HttpError && (e.status === 401 || e.status === 403) && refreshes < 3) {
            await refresh();
            continue;
          }
          throw e;
        }
      }
    };
    const inits = await Promise.all(tracks.map((t) => get(() => t.rep.initUrl)));
    const muxer = new Fmp4Muxer(tracks.map((t, i) => ({ kind: t.kind, init: inits[i] })));
    const ext = spec.mode === "audio" ? ".m4a" : ".mp4";
    const sink = await hooks.openSink(ext);
    try {
      await sink.write(muxer.header());
      const tasks = [];
      tracks.forEach((t, ti) => {
        let s = 0;
        t.segments.forEach((seg, i) => {
          tasks.push({ track: ti, index: i, start: s });
          s += seg.duration;
        });
      });
      tasks.sort((a, b) => a.start - b.start || a.track - b.track);
      const total = tasks.length;
      let fetched = 0;
      let nextFetch = 0;
      let nextWrite = 0;
      let draining = false;
      let failure = null;
      const ready = /* @__PURE__ */ new Map();
      let waiters = [];
      const wakeAll = () => {
        const w = waiters;
        waiters = [];
        w.forEach((f) => f());
      };
      let lastEmit = 0;
      const emit = (force = false) => {
        const now = Date.now();
        if (!force && now - lastEmit < 500) return;
        lastEmit = now;
        samples.push([now, bytes]);
        while (samples.length > 1 && now - samples[0][0] > 4e3) samples.shift();
        const a = samples[0];
        const dt = (now - a[0]) / 1e3;
        const speed = dt > 0 ? (bytes - a[1]) / dt : 0;
        const frac = total ? fetched / total : 0;
        const est = frac > 0 ? bytes / frac : 0;
        hooks.progress({ itemId: spec.itemId, percent: frac * 100, bytes, speed, eta: speed > 0 ? Math.max(0, est - bytes) / speed : Infinity, phase: "Downloading" });
      };
      const drain = async () => {
        if (draining) return;
        draining = true;
        try {
          while (ready.has(nextWrite)) {
            const d = ready.get(nextWrite);
            ready.delete(nextWrite);
            const t = tasks[nextWrite];
            await sink.write(muxer.fragment(t.track, d));
            nextWrite++;
            wakeAll();
          }
        } finally {
          draining = false;
        }
      };
      const worker = async () => {
        while (!failure && !signal.aborted) {
          const i = nextFetch;
          if (i >= total) return;
          if (i - nextWrite >= spec.concurrency * 3) {
            await new Promise((r) => waiters.push(r));
            continue;
          }
          nextFetch++;
          const t = tasks[i];
          try {
            const data = await get(() => tracks[t.track].segments[t.index].url);
            ready.set(i, data);
            fetched++;
            emit();
            await drain();
          } catch (e) {
            failure ??= e;
            wakeAll();
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, spec.concurrency) }, worker));
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (failure) throw failure;
      await drain();
      for (const p of muxer.durationPatches()) await sink.patch(p.offset, p.bytes);
      emit(true);
      await sink.finish();
      return { name: sink.name, sink };
    } catch (e) {
      await sink.abort();
      throw e;
    }
  }

  // src/lib/filename.ts
  function uniqueName(base, ext, existing) {
    const taken = new Set([...existing].map((e) => e.toLowerCase()));
    let name = `${base}${ext}`;
    for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${base}_${i}${ext}`;
    return name;
  }

  // src/shared/idb.ts
  var DB = "sp-video-grabber";
  var STORE = "kv";
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(key) {
    const db = await open();
    return new Promise((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }

  // src/engine/sink.ts
  async function openOpfsSink(fileName) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(fileName, { create: true });
    const h = await fh.createSyncAccessHandle();
    let pos = 0;
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        try {
          h.flush();
          h.close();
        } catch {
        }
      }
    };
    return {
      kind: "opfs",
      name: fileName,
      async write(b) {
        h.write(b, { at: pos });
        pos += b.length;
      },
      async patch(offset, b) {
        h.write(b, { at: offset });
      },
      async finish() {
        close();
      },
      async abort() {
        close();
        await root.removeEntry(fileName).catch(() => void 0);
      }
    };
  }
  async function getOutputDir() {
    try {
      const dir = await idbGet("outputDir");
      if (dir && await dir.queryPermission({ mode: "readwrite" }) === "granted") return dir;
    } catch {
    }
    return null;
  }
  async function openFolderSink(dir, base, ext) {
    const names = [];
    for await (const [n] of dir.entries()) names.push(n);
    const name = uniqueName(base, ext, names);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    let pos = 0;
    return {
      kind: "folder",
      name,
      async write(b) {
        await w.write({ type: "write", position: pos, data: b });
        pos += b.length;
      },
      async patch(offset, b) {
        await w.write({ type: "write", position: offset, data: b });
      },
      async finish() {
        await w.close();
      },
      async abort() {
        await w.abort().catch(() => void 0);
        await dir.removeEntry(name).catch(() => void 0);
      }
    };
  }

  // src/mux-worker.ts
  var ctl = new AbortController();
  var pending = /* @__PURE__ */ new Map();
  var reqId = 0;
  self.onmessage = async (e) => {
    const m = e.data;
    if (m.cmd === "cancel") return ctl.abort();
    if (m.cmd === "refresh-result") {
      pending.get(m.reqId)?.(m.candidates);
      pending.delete(m.reqId);
      return;
    }
    const { spec, base, useFolder } = m;
    try {
      const res = await runDownload(spec, base, {
        signal: ctl.signal,
        progress: (progress) => self.postMessage({ kind: "progress", progress }),
        log: (msg) => self.postMessage({ kind: "log", msg }),
        refresh: () => new Promise((resolve) => {
          const id = ++reqId;
          pending.set(id, resolve);
          self.postMessage({ kind: "refresh", reqId: id });
        }),
        openSink: async (ext) => {
          if (useFolder) {
            const dir = await getOutputDir();
            if (dir) return openFolderSink(dir, base, ext);
          }
          return openOpfsSink(`${spec.itemId}${ext}`);
        }
      });
      self.postMessage({ kind: "done", name: res.name, sinkKind: res.sink.kind });
    } catch (err) {
      const e2 = err;
      self.postMessage({ kind: "error", error: e2.message ?? String(err), cancelled: e2.name === "AbortError" || ctl.signal.aborted });
    }
  };
})();
