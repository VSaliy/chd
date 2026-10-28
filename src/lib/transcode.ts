/** Newer `oneDrive.transcode` delivery with AES-128-CBC encrypted segments. */
export interface TranscodeRef {
  driveId: string;
  itemId: string;
  url: URL;
}

const RE = /\/_api_cached\/v2\.1\/drives\/([^/]+)\/items\/([^/]+)\/oneDrive\.transcode/i;

export function parseTranscodeUrl(url: string): TranscodeRef | null {
  try {
    const u = new URL(url);
    const m = RE.exec(u.pathname);
    if (!m) return null;
    return { driveId: m[1] as string, itemId: m[2] as string, url: u };
  } catch {
    return null;
  }
}

export function transcodePart(url: string): string | null {
  return parseTranscodeUrl(url)?.url.searchParams.get("part") ?? null;
}

export function buildTranscodeUrl(sample: string, part: "index" | "initsegment" | "mediasegment" | "key", track: "video" | "audio" | null, extra: Record<string, string> = {}): string {
  const u = new URL(sample);
  u.searchParams.set("part", part);
  if (track) u.searchParams.set("track", track);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

export function decodeBytes(s: string): Uint8Array {
  const clean = s.trim();
  if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const bin = atob(clean.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface AesParams {
  key: Uint8Array;
  iv: Uint8Array;
}

/**
 * Parse `dashConfig.cdnDecryptionKey`. Accepts `{key, iv}` objects or `"key:iv"` /
 * `"key,iv"` strings (hex or base64). A missing IV defaults to zeros.
 */
export function parseDecryptionKey(v: unknown): AesParams | null {
  let k: string | undefined;
  let iv: string | undefined;
  if (typeof v === "string") [k, iv] = v.split(/[:,]/);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    k = (o["key"] ?? o["Key"]) as string | undefined;
    iv = (o["iv"] ?? o["IV"] ?? o["Iv"]) as string | undefined;
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
