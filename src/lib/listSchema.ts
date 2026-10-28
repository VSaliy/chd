/** Sharedown-style `ListSchema[".videoManifestUrl"]` template filling. */

export interface ListDataResponse {
  ListSchema?: Record<string, unknown>;
  ListData?: { Row?: Array<Record<string, unknown>> };
  Row?: Array<Record<string, unknown>>;
}

export const LIST_DATA_URL_MARKERS = [
  "RenderListDataAsStream?@a1=",
  "RenderListDataAsStream?@listUrl",
  "SP.List.GetListDataAsStream?listFullUrl",
];

export function isListDataUrl(url: string): boolean {
  return LIST_DATA_URL_MARKERS.some((m) => url.includes(m));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Fill the template of the first row of the response. `rowIndex` selects the row
 * (defaults to 0). Returns null when no template exists.
 */
export function buildManifestFromListData(data: ListDataResponse, rowIndex = 0): string | null {
  const schema = data.ListSchema ?? {};
  const template = str(schema[".videoManifestUrl"]);
  if (!template) return null;
  const rows = data.ListData?.Row ?? data.Row ?? [];
  const row = rows[rowIndex] ?? {};
  const pick = (key: string): string => str(row[key] ?? schema[key]);
  const values: Record<string, string> = {
    "{.mediaBaseUrl}": pick(".mediaBaseUrl"),
    "{.fileType}": str(row["File_x0020_Type"] ?? row[".fileType"] ?? schema[".fileType"]),
    "{.callerStack}": pick(".callerStack"),
    "{.spItemUrl}": pick(".spItemUrl"),
    "{.driveAccessToken}": pick(".driveAccessToken"),
  };
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  let u: URL;
  try {
    u = new URL(out);
  } catch {
    return null;
  }
  const set: Record<string, string> = {
    action: "Access",
    part: "Index",
    format: "dash",
    useScf: "True",
    pretranscode: "0",
    transcodeahead: "0",
  };
  for (const [k, v] of Object.entries(set)) u.searchParams.set(k, v);
  return u.toString();
}

/** URL of the RenderListDataAsStream endpoint to POST to when nothing was captured. */
export function renderListDataUrl(origin: string, sitePath: string, listRelativePath: string): string {
  const site = sitePath.replace(/\/$/, "");
  const list = listRelativePath.replace(/'/g, "''");
  return (
    `${origin}${site}/_api/web/GetList(@a1)/RenderListDataAsStream` +
    `?@a1=${encodeURIComponent(`'${list}'`)}`
  );
}

/** `/sites/x`, `/personal/y`, `/teams/z` prefix of a SharePoint path ("" for root sites). */
export function sitePathOf(pathname: string): string {
  const m = /^\/(sites|personal|teams)\/[^/]+/i.exec(pathname);
  return m ? m[0] : "";
}
