/** Only these tenant hosts may ever be contacted (mirrors manifest host_permissions). */
const ALLOWED = [/(^|\.)sharepoint\.com$/i, /(^|\.)sharepoint\.com\.mcas\.ms$/i, /(^|\.)svc\.ms$/i, /^teams\.microsoft\.com$/i, /^teams\.cloud\.microsoft$/i, /^teams\.microsoft\.com\.mcas\.ms$/i];

export function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

export function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sanitise a user-provided Downloads subfolder: no traversal, no reserved characters. */
export function sanitizeSubfolder(p: string): string {
  return p
    .split(/[\\/]+/)
    // eslint-disable-next-line no-control-regex
    .map((s) => s.replace(/[<>:"|?*\u0000-\u001f]/g, "").replace(/[. ]+$/, "").trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}
