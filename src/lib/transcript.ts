/** Transcript JSON (Teams/Stream) conversion. */
export interface Cue {
  start: number;
  end: number;
  speaker: string;
  text: string;
}
export type TranscriptFormat = "json" | "vtt" | "txt" | "srt";

export function parseOffset(v: unknown): number {
  if (typeof v === "number") return v > 1e6 ? v / 1e7 : v;
  if (typeof v !== "string") return 0;
  const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v);
  if (iso) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  const parts = v.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((a, p) => a * 60 + p, 0);
}

interface RawEntry {
  text?: string;
  speakerDisplayName?: string;
  speaker?: string;
  startOffset?: unknown;
  endOffset?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

export function parseTranscript(json: unknown): Cue[] {
  const obj = json as { entries?: RawEntry[]; events?: RawEntry[] } | RawEntry[];
  const list = Array.isArray(obj) ? obj : (obj?.entries ?? obj?.events ?? []);
  return list
    .filter((e) => typeof e.text === "string" && e.text.trim() !== "")
    .map((e) => ({
      start: parseOffset(e.startOffset ?? e.startTime),
      end: parseOffset(e.endOffset ?? e.endTime),
      speaker: e.speakerDisplayName ?? e.speaker ?? "",
      text: (e.text as string).trim(),
    }));
}

function ts(sec: number, sep: "." | ","): string {
  const ms = Math.round(sec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

const escVtt = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toVtt(cues: Cue[]): string {
  const body = cues
    .map((c) => `${ts(c.start, ".")} --> ${ts(c.end, ".")}\n${c.speaker ? `<v ${escVtt(c.speaker.replace(/[\n>]/g, " "))}>` : ""}${escVtt(c.text)}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

export function toSrt(cues: Cue[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${ts(c.start, ",")} --> ${ts(c.end, ",")}\n${c.speaker ? `${c.speaker}: ` : ""}${c.text}`)
      .join("\n\n") + "\n"
  );
}

/** One block per run of a single speaker. */
export function toGroupedText(cues: Cue[], withTimestamps = false): string {
  const blocks: { speaker: string; start: number; texts: string[] }[] = [];
  for (const c of cues) {
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === c.speaker) last.texts.push(c.text);
    else blocks.push({ speaker: c.speaker, start: c.start, texts: [c.text] });
  }
  return (
    blocks
      .map((b) => {
        const stamp = withTimestamps ? `[${ts(b.start, ".").slice(0, 8)}] ` : "";
        return `${stamp}${b.speaker || "Unknown"}:\n${b.texts.join(" ")}`;
      })
      .join("\n\n") + "\n"
  );
}

export function convertTranscript(json: unknown, format: TranscriptFormat, withTimestamps = true): string {
  if (format === "json") return JSON.stringify(json, null, 2);
  const cues = parseTranscript(json);
  if (format === "vtt") return toVtt(cues);
  if (format === "srt") return toSrt(cues);
  return toGroupedText(cues, withTimestamps);
}

export const TRANSCRIPT_EXT: Record<TranscriptFormat, string> = { json: ".json", vtt: ".vtt", txt: ".txt", srt: ".srt" };

export function transcriptSuffix(format: TranscriptFormat, suffixes: { plain: string; grouped: string }): string {
  return format === "txt" ? suffixes.grouped : suffixes.plain;
}
