/** URL helpers for transcript discovery. */
export function isTranscriptListUrl(url: string): boolean {
  return url.includes("transcripts") && !url.includes("/content") && !url.includes("/cdnmedia/");
}

export function withJsonFormat(url: string): string {
  const u = new URL(url);
  u.searchParams.set("format", "json");
  return u.toString();
}

export function extractTemporaryDownloadUrl(data: unknown): string | null {
  let found: string | null = null;
  const walk = (v: unknown) => {
    if (found || v == null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o["temporaryDownloadUrl"] === "string") {
      found = o["temporaryDownloadUrl"];
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(data);
  return found;
}

export function driveItemTranscriptUrls(origin: string, sitePath: string, driveId: string, itemId: string): string[] {
  const base = `${origin}${sitePath}/_api/v2.1/drives/${driveId}/items/${itemId}`;
  return [
    `${base}?select=media/transcripts,audioTracks&$expand=media/transcripts,media/audioTracks`,
    `${base}/media/transcripts`,
  ];
}

export function driveItemFromUrl(url: string): { driveId: string; itemId: string } | null {
  const m = /\/drives\/([^/?#]+)\/items\/([^/?#]+)/i.exec(url);
  return m ? { driveId: decodeURIComponent(m[1] as string), itemId: decodeURIComponent(m[2] as string) } : null;
}
