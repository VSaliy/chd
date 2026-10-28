/** Direct download URL (PatBQc's method) from `stream.aspx?id=`. */
export function directUrlFromStreamPage(pageUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  const id = u.searchParams.get("id");
  if (!id) return null;
  // URLSearchParams already decodes %XX and turns '+' into a space.
  const path = id.startsWith("/") ? id : "/" + id;
  const encoded = path.split("/").map((s) => encodeURIComponent(s)).join("/");
  return `${u.origin}${encoded}?download=1`;
}
