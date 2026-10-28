/** Download engine: manifest -> segments -> (decrypt) -> fMP4 mux -> sink. */
import { parseMpd, pickAudio, pickVideo, type ParsedMpd, type QualityPreset, type Representation } from "../lib/mpd";
import { fetchWithRetry, HttpError } from "../lib/retry";
import { Fmp4Muxer } from "../lib/fmp4";
import { decodeBytes } from "../lib/transcode";
import type { AuthHeaders, Candidate, Mode, Progress } from "../types";
import type { Sink } from "./sink";

export interface JobSpec {
  itemId: string;
  candidates: Candidate[];
  mode: Mode;
  quality: string;
  concurrency: number;
}

export interface Hooks {
  progress(p: Progress): void;
  /** Ask the page for a fresh manifest (token expired). */
  refresh(): Promise<Candidate[] | null>;
  openSink(ext: string): Promise<Sink>;
  log(msg: string): void;
  signal: AbortSignal;
}

interface Track {
  rep: Representation;
  kind: "video" | "audio";
  segments: Representation["segments"];
}

function hdrs(h?: AuthHeaders): Record<string, string> {
  const o: Record<string, string> = {};
  if (h?.authorization) o["Authorization"] = h.authorization;
  if (h?.spopactoken) o["x-spopactoken"] = h.spopactoken;
  return o;
}

export function presetOf(q: string): QualityPreset {
  return q === "best" || q === "1080" || q === "720" ? q : { id: q };
}

function choose(mpd: ParsedMpd, mode: Mode, quality: string): Track[] {
  const out: Track[] = [];
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

export async function runDownload(spec: JobSpec, base: string, hooks: Hooks): Promise<{ name: string; sink: Sink }> {
  const { signal } = hooks;
  let cand: Candidate | undefined;
  let mpd: ParsedMpd | undefined;
  let lastErr: unknown;

  const loadMpd = async (c: Candidate): Promise<ParsedMpd> => {
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
      hooks.log(`Candidate ${c.kind} failed: ${(e as Error).message}`);
      if (signal.aborted) throw e;
    }
  }
  if (!cand || !mpd) throw lastErr instanceof Error ? lastErr : new Error("No usable stream manifest found.");
  const active = { cand, mpd };

  const tracks = choose(mpd, spec.mode, spec.quality);
  let aesKey: CryptoKey | null = null;
  let aesIv: Uint8Array | null = null;
  if (cand.aes) {
    aesKey = await crypto.subtle.importKey("raw", decodeBytes(cand.aes.key) as BufferSource, "AES-CBC", false, ["decrypt"]);
    aesIv = decodeBytes(cand.aes.iv);
  }

  let refreshing: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    refreshing ??= (async () => {
      hooks.log("Token appears to have expired; re-reading the page");
      const fresh = await hooks.refresh();
      if (!fresh?.length) throw new Error("Session expired and the manifest could not be refreshed.");
      let m: ParsedMpd | undefined;
      let used: Candidate | undefined;
      for (const c of fresh) {
        if (c.kind === "direct") continue;
        try {
          m = await loadMpd(c);
          used = c;
          break;
        } catch {
          /* try next */
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
  const samples: Array<[number, number]> = [];
  const get = async (urlOf: () => string): Promise<Uint8Array> => {
    for (let refreshes = 0; ; refreshes++) {
      try {
        const r = await fetchWithRetry(urlOf(), { credentials: "include", headers: hdrs(active.cand.headers) }, { signal });
        let buf = new Uint8Array(await r.arrayBuffer());
        bytes += buf.length;
        if (aesKey && aesIv) buf = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: aesIv as BufferSource }, aesKey, buf));
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
  const muxer = new Fmp4Muxer(tracks.map((t, i) => ({ kind: t.kind, init: inits[i] as Uint8Array })));
  const ext = spec.mode === "audio" ? ".m4a" : ".mp4";
  const sink = await hooks.openSink(ext);
  try {
    await sink.write(muxer.header());

    interface Task {
      track: number;
      index: number;
      start: number;
    }
    const tasks: Task[] = [];
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
    let failure: unknown = null;
    const ready = new Map<number, Uint8Array>();
    let waiters: Array<() => void> = [];
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
      while (samples.length > 1 && now - (samples[0] as [number, number])[0] > 4000) samples.shift();
      const a = samples[0] as [number, number];
      const dt = (now - a[0]) / 1000;
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
          const d = ready.get(nextWrite) as Uint8Array;
          ready.delete(nextWrite);
          const t = tasks[nextWrite] as Task;
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
          await new Promise<void>((r) => waiters.push(r));
          continue;
        }
        nextFetch++;
        const t = tasks[i] as Task;
        try {
          const data = await get(() => (tracks[t.track] as Track).segments[t.index]!.url);
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
