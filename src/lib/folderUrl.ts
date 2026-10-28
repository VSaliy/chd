/** Folder share-link detection and REST URL building (Sharedown). */
import { sitePathOf } from "./listSchema";

const SHARE_RE = /\/:f:\/[a-z]\/[^/?#]+\/[^/?#]+/i;

export function isFolderShareLink(url: string): boolean {
  try {
    return SHARE_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface FolderRef {
  origin: string;
  sitePath: string;
  serverRelativePath: string;
}

/** Resolve a folder reference from a (post-redirect) page URL carrying `id=`. */
export function folderRefFromUrl(url: string): FolderRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const id = u.searchParams.get("id");
  const path = id ? (id.startsWith("/") ? id : "/" + id) : u.pathname;
  if (!id && !/^\/(sites|personal|teams)\//i.test(path)) return null;
  return { origin: u.origin, sitePath: sitePathOf(path), serverRelativePath: path.replace(/\/$/, "") };
}

function rel(ref: FolderRef, kind: "Folders" | "Files", extra: string): string {
  const p = ref.serverRelativePath.replace(/'/g, "''");
  return `${ref.origin}${ref.sitePath}/_api/web/GetFolderByServerRelativeUrl('${encodeURIComponent(p)}')/${kind}${extra}`;
}

export const foldersUrl = (ref: FolderRef) => rel(ref, "Folders", "?$select=Name,ServerRelativeUrl,TimeCreated,TimeLastModified");
export const filesUrl = (ref: FolderRef) =>
  rel(ref, "Files", "?$select=Name,ServerRelativeUrl,TimeCreated,TimeLastModified,Length,UniqueId");

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|mpg|mpeg)$/i;
export const isVideoFile = (name: string) => VIDEO_EXT.test(name);

export interface FolderFile {
  Name: string;
  ServerRelativeUrl: string;
  TimeCreated?: string;
  TimeLastModified?: string;
}
export type SortKey = "created" | "modified" | "name";

export function filterAndSortVideos<T extends FolderFile>(files: T[], key: SortKey): T[] {
  const v = files.filter((f) => isVideoFile(f.Name));
  const cmpDate = (a?: string, b?: string) => (Date.parse(a ?? "") || 0) - (Date.parse(b ?? "") || 0);
  return v.sort((a, b) =>
    key === "name"
      ? a.Name.localeCompare(b.Name, undefined, { numeric: true })
      : key === "created"
        ? cmpDate(a.TimeCreated, b.TimeCreated)
        : cmpDate(a.TimeLastModified, b.TimeLastModified),
  );
}

/** Page URL that opens a file in the SharePoint stream player. */
export function streamPageUrl(ref: FolderRef, fileServerRelativeUrl: string): string {
  const site = ref.sitePath || "";
  return `${ref.origin}${site}/_layouts/15/stream.aspx?id=${encodeURIComponent(fileServerRelativeUrl)}`;
}
