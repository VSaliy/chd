/**
 * Minimal fragmented-MP4 muxer. Takes the init segments and media fragments of
 * separately delivered DASH tracks and writes a single fragmented MP4 with
 * unique track IDs. The header can be patched with the final duration so that
 * players report it correctly.
 */

export interface Box {
  type: string;
  start: number;
  end: number;
  header: number;
}

export function readBoxes(buf: Uint8Array, start = 0, end = buf.length): Box[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4]!, buf[p + 5]!, buf[p + 6]!, buf[p + 7]!);
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

const find = (buf: Uint8Array, boxes: Box[], t: string) => boxes.find((b) => b.type === t);
const inner = (buf: Uint8Array, b: Box) => readBoxes(buf, b.start + b.header, b.end);

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
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

const u32 = (...v: number[]) => {
  const a = new Uint8Array(v.length * 4);
  const dv = new DataView(a.buffer);
  v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0));
  return a;
};

export interface TrackInfo {
  trackId: number;
  timescale: number;
  trak: Uint8Array;
  trex: Uint8Array;
}

export function readInit(init: Uint8Array): TrackInfo {
  const top = readBoxes(init);
  const moov = find(init, top, "moov");
  if (!moov) throw new Error("init segment has no moov");
  const mb = inner(init, moov);
  const trakBox = find(init, mb, "trak");
  if (!trakBox) throw new Error("init segment has no trak");
  const tb = inner(init, trakBox);
  const tkhd = find(init, tb, "tkhd")!;
  const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const tkhdVer = init[tkhd.start + 8]!;
  const trackId = dv.getUint32(tkhd.start + (tkhdVer === 1 ? 28 : 20));
  const mdia = find(init, tb, "mdia")!;
  const mdhd = find(init, inner(init, mdia), "mdhd")!;
  const mdhdVer = init[mdhd.start + 8]!;
  const timescale = dv.getUint32(mdhd.start + (mdhdVer === 1 ? 28 : 20));
  const mvex = find(init, mb, "mvex");
  const trexBox = mvex ? find(init, inner(init, mvex), "trex") : undefined;
  const trex = trexBox ? init.slice(trexBox.start, trexBox.end) : box("trex", u32(0, trackId, 1, 0, 0, 0));
  return { trackId, timescale, trak: init.slice(trakBox.start, trakBox.end), trex };
}

export interface FragmentInfo {
  trackId: number;
  baseTime: number;
  duration: number;
}

/** Rewrite track IDs / sequence number in-place on a copy and return the fragment bytes + timing. */
export function processSegment(seg: Uint8Array, newTrackId: number, sequence: number, defaultDuration = 0): { bytes: Uint8Array; info: FragmentInfo | null } {
  const out = new Uint8Array(seg.length);
  let w = 0;
  let info: FragmentInfo | null = null;
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
    const rel = (x: number) => x - b.start + start;
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
          const flags = dv.getUint32(o) & 0xffffff;
          let q = o + 8;
          if (flags & 1) q += 8;
          if (flags & 2) q += 4;
          if (flags & 8) defDur = dv.getUint32(q);
        } else if (t.type === "tfdt") {
          baseTime = seg[o] === 1 ? Number(dv.getBigUint64(o + 4)) : dv.getUint32(o + 4);
        } else if (t.type === "trun") {
          const flags = dv.getUint32(o) & 0xffffff;
          const count = dv.getUint32(o + 4);
          let q = o + 8;
          if (flags & 1) q += 4;
          if (flags & 4) q += 4;
          const per = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
          for (let i = 0; i < count; i++) {
            dur += flags & 0x100 ? dv.getUint32(q + i * per) : defDur;
          }
        }
      }
      info = { trackId: newTrackId, baseTime, duration: dur };
    }
  }
  return { bytes: out.slice(0, w), info };
}

export interface MuxTrack {
  kind: "video" | "audio";
  init: Uint8Array;
}

export class Fmp4Muxer {
  private tracks: (TrackInfo & { newId: number; end: number })[] = [];
  private seq = 1;
  private headerBytes: Uint8Array;
  private durOffset = 0;
  private mehdOffset = 0;

  constructor(tracks: MuxTrack[]) {
    tracks.forEach((t, i) => {
      const info = readInit(t.init);
      this.tracks.push({ ...info, newId: i + 1, end: 0 });
    });
    const audioOnly = tracks.every((t) => t.kind === "audio");
    const enc = (s: string) => new TextEncoder().encode(s);
    const brand = audioOnly ? "M4A " : "isom";
    const ftyp = box("ftyp", enc(brand), u32(0), enc("isom"), enc("iso6"), enc("mp41"));
    const mvhd = box(
      "mvhd",
      u32(0, 0, 0, 1000, 0, 0x00010000),
      new Uint8Array([0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000),
      u32(0, 0, 0, 0, 0, 0),
      u32(this.tracks.length + 1),
    );
    const mehd = box("mehd", u32(0, 0));
    const traks: Uint8Array[] = [];
    const trexes: Uint8Array[] = [];
    for (const t of this.tracks) {
      const trak = t.trak.slice();
      const tb = readBoxes(trak, 8, trak.length);
      const tkhd = tb.find((b) => b.type === "tkhd")!;
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
    this.durOffset = mvhdPos + 8 + 16; // box header(8) + ver/flags/ctime/mtime/timescale(16) -> duration
    this.mehdOffset = mvhdPos + mvhd.length + traks.reduce((a, t) => a + t.length, 0) + 8 + 8 + 4;
  }

  header(): Uint8Array {
    return this.headerBytes;
  }

  /** Rewritten fragment for track index `i`. */
  fragment(i: number, seg: Uint8Array): Uint8Array {
    const t = this.tracks[i]!;
    const { bytes, info } = processSegment(seg, t.newId, this.seq);
    this.seq += 1;
    if (info) t.end = Math.max(t.end, (info.baseTime + info.duration) / t.timescale);
    return bytes;
  }

  durationSeconds(): number {
    return Math.max(0, ...this.tracks.map((t) => t.end));
  }

  /** Patches to apply to the already-written header once the duration is known. */
  durationPatches(): { offset: number; bytes: Uint8Array }[] {
    const ms = Math.round(this.durationSeconds() * 1000);
    return [
      { offset: this.durOffset, bytes: u32(ms) },
      { offset: this.mehdOffset, bytes: u32(ms) },
    ];
  }
}
