import { describe, it, expect } from "vitest";
import { Fmp4Muxer, readBoxes, readInit } from "../../src/lib/fmp4";

const u32 = (...v: number[]) => {
  const a = new Uint8Array(v.length * 4);
  const dv = new DataView(a.buffer);
  v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0));
  return a;
};
function box(type: string, ...parts: Uint8Array[]) {
  const len = parts.reduce((a, p) => a + p.length, 8);
  const o = new Uint8Array(len);
  new DataView(o.buffer).setUint32(0, len);
  for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
  let p = 8;
  for (const x of parts) (o.set(x, p), (p += x.length));
  return o;
}
function init(trackId: number, timescale: number) {
  const tkhd = box("tkhd", u32(0, 0, 0, trackId, 0, 0), new Uint8Array(60));
  const mdhd = box("mdhd", u32(0, 0, 0, timescale, 0, 0));
  const trak = box("trak", tkhd, box("mdia", mdhd));
  const mvex = box("mvex", box("trex", u32(0, trackId, 1, 0, 0, 0)));
  return box("moov", box("mvhd", new Uint8Array(100)), trak, mvex);
}
function fragment(trackId: number, base: number, durations: number[]) {
  const tfhd = box("tfhd", u32(0x020000, trackId));
  const tfdt = box("tfdt", u32(0, base));
  const trun = box("trun", u32(0x000101, durations.length, 0), ...durations.map((d) => u32(d)));
  const moof = box("moof", box("mfhd", u32(0, 99)), box("traf", tfhd, tfdt, trun));
  return new Uint8Array([...box("styp", u32(1)), ...moof, ...box("mdat", new Uint8Array(10))]);
}

describe("fmp4 muxer", () => {
  it("merges tracks, renumbers ids and patches duration", () => {
    expect(readInit(init(7, 1000)).trackId).toBe(7);
    const m = new Fmp4Muxer([
      { kind: "video", init: init(1, 1000) },
      { kind: "audio", init: init(1, 48000) },
    ]);
    const hdr = m.header().slice();
    expect(readBoxes(hdr).map((b) => b.type)).toEqual(["ftyp", "moov"]);
    const v = m.fragment(0, fragment(1, 0, [2000, 2000]));
    const a = m.fragment(1, fragment(1, 0, [96000, 96000]));
    expect(readBoxes(v).map((b) => b.type)).toEqual(["moof", "mdat"]);
    const dvv = new DataView(v.buffer);
    const dva = new DataView(a.buffer);
    // moof(8) mfhd(8) -> seq at +12 within mfhd
    expect(dvv.getUint32(8 + 12)).toBe(1);
    expect(dva.getUint32(8 + 12)).toBe(2);
    // tfhd track id: moof hdr 8 + mfhd 16 + traf hdr 8 + tfhd hdr/flags 12
    expect(dvv.getUint32(8 + 16 + 8 + 12)).toBe(1);
    expect(dva.getUint32(8 + 16 + 8 + 12)).toBe(2);
    expect(m.durationSeconds()).toBe(4);
    for (const p of m.durationPatches()) hdr.set(p.bytes, p.offset);
    const dv = new DataView(hdr.buffer);
    const moov = readBoxes(hdr).find((b) => b.type === "moov")!;
    const mvhd = readBoxes(hdr, moov.start + 8, moov.end)[0]!;
    expect(dv.getUint32(mvhd.start + 24)).toBe(4000);
    const mvex = readBoxes(hdr, moov.start + 8, moov.end).find((b) => b.type === "mvex")!;
    const mehd = readBoxes(hdr, mvex.start + 8, mvex.end)[0]!;
    expect(mehd.type).toBe("mehd");
    expect(dv.getUint32(mehd.start + 12)).toBe(4000);
  });
});
