/** DASH MPD parsing (SegmentTemplate/SegmentTimeline, SegmentList, BaseURL). */
import { XNode, parseXml, child, childrenOf } from "./xml";

export interface Segment {
  url: string;
  /** seconds */
  duration: number;
}
export interface Representation {
  id: string;
  kind: "video" | "audio" | "text";
  mimeType: string;
  codecs: string;
  bandwidth: number;
  width?: number;
  height?: number;
  lang?: string;
  initUrl: string;
  segments: Segment[];
  duration: number;
}
export interface ParsedMpd {
  duration: number;
  representations: Representation[];
}

export function parseIsoDuration(s: string | undefined): number {
  if (!s) return 0;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/** Resolve a (possibly relative) URL, preserving the query when the ref has none (SharePoint tokens). */
export function resolveUrl(ref: string, base: string): string {
  return new URL(ref, base).toString();
}

function fill(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (m, k: string, w?: string) => {
    if (k === "") return "$";
    const v = vars[k];
    if (v === undefined) return m;
    return w ? String(v).padStart(Number(w), "0") : String(v);
  }).replace(/\$\$/g, "$");
}

function kindOf(mime: string, contentType: string): Representation["kind"] {
  const s = `${mime} ${contentType}`;
  if (s.includes("video")) return "video";
  if (s.includes("audio")) return "audio";
  return "text";
}

export function parseMpd(xml: string, manifestUrl: string): ParsedMpd {
  const mpd = parseXml(xml);
  const total = parseIsoDuration(mpd.attrs["mediaPresentationDuration"]);
  const mpdBase = child(mpd, "BaseURL")?.text.trim();
  const out: Representation[] = [];
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
        const attr = (k: string) => rep.attrs[k] ?? set.attrs[k];
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
        let segments: Segment[] = [];
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
              if (s.attrs["t"] !== undefined) t = Number(s.attrs["t"]);
              const d = Number(s.attrs["d"]);
              const r = Number(s.attrs["r"] ?? 0);
              for (let i = 0; i <= r; i++) {
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
                  duration: Math.min(segDur, periodDur - i * segDur),
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
        const r: Representation = {
          id,
          kind,
          mimeType: mime,
          codecs: attr("codecs") ?? "",
          bandwidth,
          initUrl,
          segments,
          duration: segments.reduce((a, s) => a + s.duration, 0) || periodDur,
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

export type QualityPreset = "best" | "1080" | "720" | { id: string };

/** Pick a video representation according to a preset (heights compare via `height`). */
export function pickVideo(reps: Representation[], preset: QualityPreset): Representation | undefined {
  const v = reps.filter((r) => r.kind === "video");
  if (typeof preset === "object") return v.find((r) => r.id === preset.id);
  const cap = preset === "best" ? Infinity : Number(preset);
  const byQuality = (a: Representation, b: Representation) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth;
  const ok = v.filter((r) => (r.height ?? 0) <= cap).sort(byQuality);
  return ok[0] ?? [...v].sort(byQuality).pop();
}

export function pickAudio(reps: Representation[]): Representation | undefined {
  return reps.filter((r) => r.kind === "audio").sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

export function describeRepresentation(r: Representation): string {
  const res = r.height ? `${r.width ?? "?"}x${r.height} ` : "";
  return `${res}${Math.round(r.bandwidth / 1000)} kbps ${r.codecs}`.trim();
}
