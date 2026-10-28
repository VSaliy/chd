/** Filename sanitising and template expansion. */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_NAME_LENGTH = 150;

export function sanitizeFilename(name: string, fallbackId = "unknown"): string {
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ");
  s = s.replace(/[. ]+$/, "").replace(/^\s+/, "");
  if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH).replace(/[. ]+$/, "");
  if (!s) return `video_${fallbackId}`;
  const base = s.split(".")[0] ?? s;
  if (RESERVED.test(base)) s = "_" + s;
  return s;
}

export interface NameTokens {
  title: string;
  site?: string;
  quality?: string;
  id?: string;
  now?: Date;
}

const p2 = (n: number) => String(n).padStart(2, "0");

export function applyTemplate(template: string, t: NameTokens): string {
  const now = t.now ?? new Date();
  const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const time = `${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
  const map: Record<string, string> = {
    title: t.title ?? "",
    date,
    time,
    site: t.site ?? "",
    quality: t.quality ?? "",
    id: t.id ?? "",
  };
  const out = (template || "{title}").replace(/\{(\w+)\}/g, (m, k: string) => (k in map ? (map[k] as string) : m));
  return sanitizeFilename(out, t.id || "unknown");
}

/** Append `_1`, `_2`, ... until the name is not in `existing` (case-insensitive). */
export function uniqueName(base: string, ext: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((e) => e.toLowerCase()));
  let name = `${base}${ext}`;
  for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${base}_${i}${ext}`;
  return name;
}
