/** Pure helpers for locating and normalising SharePoint video manifest URLs. */

export function isManifestUrl(url: string): boolean {
  return url.includes("videomanifest") && !url.includes("tempauth");
}

/** Force `part=index&format=dash` on a manifest URL, keeping the other params. */
export function normalizeManifestUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("part", "index");
  u.searchParams.set("format", "dash");
  return u.toString();
}

/** Build a manifest URL from `g_fileInfo['.transformUrl']`. */
export function manifestFromTransformUrl(transformUrl: string, base?: string): string | null {
  let u: URL;
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
