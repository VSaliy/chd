/** Isolated-world content script: per-frame state, discovery, UI injection. */
import { isManifestUrl, manifestFromTransformUrl, normalizeManifestUrl } from "./lib/manifestUrl";
import { buildManifestFromListData, renderListDataUrl, sitePathOf, type ListDataResponse } from "./lib/listSchema";
import { directUrlFromStreamPage } from "./lib/directUrl";
import { buildTranscodeUrl, parseDecryptionKey, parseTranscodeUrl } from "./lib/transcode";
import { driveItemFromUrl, driveItemTranscriptUrls, extractTemporaryDownloadUrl, withJsonFormat } from "./lib/transcriptApi";
import { fetchWithRetry } from "./lib/retry";
import type { AuthHeaders, Candidate, FileInfo, Msg, PageInfo } from "./types";
import { mountUi } from "./content-ui";

interface State {
  nonce: string;
  auth: AuthHeaders;
  manifests: Map<string, Candidate>;
  lists: ListDataResponse[];
  transcriptLists: unknown[];
  fileInfo: FileInfo & { transformUrl?: string; spItemUrl?: string };
  cdnKey: unknown;
  title: string;
  directOk: boolean | null;
}

const st: State = {
  nonce: "",
  auth: {},
  manifests: new Map(),
  lists: [],
  transcriptLists: [],
  fileInfo: {},
  cdnKey: undefined,
  title: "",
  directOk: null,
};

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function siteName(): string {
  const m = /^\/(?:sites|personal|teams)\/([^/]+)/i.exec(location.pathname);
  return m ? decodeURIComponent(m[1] as string) : location.hostname.split(".")[0] ?? "";
}

export function computeInfo(): PageInfo {
  const cands: Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Candidate) => {
    if (!seen.has(c.url)) {
      seen.add(c.url);
      cands.push(c);
    }
  };
  // 1. captured manifests
  for (const c of st.manifests.values()) add({ ...c, headers: { ...c.headers, ...st.auth } });
  // 2. g_fileInfo fallback
  if (st.fileInfo.transformUrl) {
    const u = manifestFromTransformUrl(st.fileInfo.transformUrl, location.href);
    if (u) add({ kind: "filefallback", url: u, headers: { ...st.auth } });
  }
  // 3. list data template
  for (const l of st.lists) {
    const u = buildManifestFromListData(l);
    if (u) add({ kind: "listdata", url: u, headers: { ...st.auth } });
  }
  // 4. transcode delivery
  const aes = parseDecryptionKey(st.cdnKey);
  for (const e of performance.getEntriesByType("resource")) {
    if (parseTranscodeUrl(e.name)) {
      const c: Candidate = { kind: "transcode", url: buildTranscodeUrl(e.name, "index", null, { format: "dash" }), headers: { ...st.auth } };
      if (aes) c.aes = { key: toHex(aes.key), iv: toHex(aes.iv) };
      add(c);
      break;
    }
  }
  // 5. direct download
  if (st.directOk) {
    const d = directUrlFromStreamPage(location.href);
    if (d) add({ kind: "direct", url: d });
  }
  const driveItem =
    driveItemFromUrl(st.fileInfo.transformUrl ?? "") ?? driveItemFromUrl(st.fileInfo.spItemUrl ?? "") ?? driveItemFromUrl(cands.map((c) => c.url).join(" "));
  const fileInfo: FileInfo = { ...st.fileInfo };
  if (driveItem) Object.assign(fileInfo, driveItem);
  delete (fileInfo as { transformUrl?: string }).transformUrl;
  delete (fileInfo as { spItemUrl?: string }).spItemUrl;
  return {
    pageUrl: location.href,
    origin: location.origin,
    title: (st.fileInfo.displayName || st.title || document.title || "").trim(),
    site: siteName(),
    fileInfo,
    candidates: cands,
    hasTranscriptSource: st.fileInfo.hasTranscripts !== false && (st.transcriptLists.length > 0 || !!driveItem),
  };
}

let pushTimer: number | undefined;
function schedulePush(): void {
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    const info = computeInfo();
    ui.update(info);
    if (info.candidates.length || info.hasTranscriptSource) void chrome.runtime.sendMessage({ type: "page-info", info } satisfies Msg).catch(() => undefined);
  }, 300);
}

function onPageMessage(e: MessageEvent): void {
  if (e.source !== window) return;
  const d = e.data as Record<string, unknown> | null;
  if (!d || d["__spvg"] !== true || d["nonce"] !== st.nonce || !st.nonce) return;
  switch (d["kind"]) {
    case "token":
      if (d["authorization"]) st.auth.authorization = String(d["authorization"]);
      if (d["spopactoken"]) st.auth.spopactoken = String(d["spopactoken"]);
      break;
    case "req": {
      const url = String(d["url"]);
      const h = (d["headers"] ?? {}) as AuthHeaders;
      if (h.authorization) st.auth.authorization = h.authorization;
      if (h.spopactoken) st.auth.spopactoken = h.spopactoken;
      if (isManifestUrl(url)) {
        try {
          const n = normalizeManifestUrl(url);
          st.manifests.set(n, { kind: "manifest", url: n, headers: h });
        } catch {
          /* ignore */
        }
      }
      break;
    }
    case "body": {
      const url = String(d["url"]);
      if (url.includes("transcripts")) st.transcriptLists.push(d["json"]);
      else st.lists.push(d["json"] as ListDataResponse);
      break;
    }
    case "state": {
      const fi = (d["fileInfo"] ?? {}) as Record<string, unknown>;
      st.fileInfo = {
        displayName: typeof fi["displayName"] === "string" ? fi["displayName"] : undefined,
        transformUrl: typeof fi["transformUrl"] === "string" ? fi["transformUrl"] : undefined,
        spItemUrl: typeof fi["spItemUrl"] === "string" ? fi["spItemUrl"] : undefined,
        hasTranscripts: typeof fi["hasTranscripts"] === "boolean" ? fi["hasTranscripts"] : undefined,
      };
      st.cdnKey = d["cdnDecryptionKey"];
      st.title = String(d["title"] ?? "");
      break;
    }
    default:
      return;
  }
  schedulePush();
}

function readState(): void {
  if (st.nonce) window.postMessage({ __spvgc: true, kind: "read-state", nonce: st.nonce }, location.origin);
}

/** Strategy 3 fallback: POST RenderListDataAsStream ourselves when nothing was captured. */
async function ensureListData(): Promise<void> {
  if (st.lists.length || st.manifests.size) return;
  const id = new URL(location.href).searchParams.get("id");
  if (!id) return;
  const sitePath = sitePathOf(id);
  const segs = id.split("/").filter(Boolean);
  const libSegs = sitePath ? sitePath.split("/").filter(Boolean).length + 1 : 1;
  const library = "/" + segs.slice(0, libSegs).join("/");
  const parent = "/" + segs.slice(0, -1).join("/");
  const url = renderListDataUrl(location.origin, sitePath, library);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = {
    parameters: {
      __metadata: { type: "SP.RenderListDataParameters" },
      RenderOptions: 12295,
      ViewXml: `<View Scope="RecursiveAll"><Query><Where><Eq><FieldRef Name="FileRef"/><Value Type="Text">${esc(id)}</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>`,
      FolderServerRelativeUrl: parent,
    },
  };
  try {
    const r = await fetchWithRetry(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json;odata=verbose", Accept: "application/json;odata=verbose", ...(st.auth.authorization ? { Authorization: st.auth.authorization } : {}) },
      body: JSON.stringify(body),
    }, { maxAttempts: 2 });
    st.lists.push((await r.json()) as ListDataResponse);
  } catch {
    /* best effort */
  }
}

async function probeDirect(): Promise<void> {
  if (st.directOk !== null) return;
  const d = directUrlFromStreamPage(location.href);
  if (!d) {
    st.directOk = false;
    return;
  }
  try {
    const r = await fetch(d, { credentials: "include", headers: { Range: "bytes=0-0" } });
    st.directOk = r.status === 200 || r.status === 206;
    void r.body?.cancel();
  } catch {
    st.directOk = false;
  }
}

export async function discover(): Promise<PageInfo> {
  readState();
  await new Promise((r) => setTimeout(r, 150));
  await ensureListData();
  await probeDirect();
  const info = computeInfo();
  ui.update(info);
  return info;
}

export async function getTranscriptJson(): Promise<unknown> {
  const fetchJson = async (url: string, auth = false) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth && st.auth.authorization) headers["Authorization"] = st.auth.authorization;
    const r = await fetchWithRetry(url, { credentials: "include", headers }, { maxAttempts: 3 });
    return r.json() as Promise<unknown>;
  };
  for (const list of st.transcriptLists) {
    const t = extractTemporaryDownloadUrl(list);
    if (t) return fetchJson(withJsonFormat(new URL(t, location.href).toString()));
  }
  if (st.fileInfo.hasTranscripts === false) throw new Error("This video has no transcript.");
  const info = computeInfo();
  const { driveId, itemId } = info.fileInfo;
  if (!driveId || !itemId) throw new Error("Transcript not found: no drive item information on this page.");
  const sitePath = sitePathOf(location.pathname);
  let lastErr: unknown = new Error("Transcript not found");
  for (const u of driveItemTranscriptUrls(location.origin, sitePath, driveId, itemId)) {
    try {
      const t = extractTemporaryDownloadUrl(await fetchJson(u, true));
      if (t) return fetchJson(withJsonFormat(new URL(t, location.href).toString()));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const ui = mountUi({ discover, getTranscriptJson, getInfo: computeInfo });

window.addEventListener("message", onPageMessage);
window.addEventListener("spvg:nonce", ((e: CustomEvent<string>) => {
  if (!st.nonce) {
    st.nonce = String(e.detail);
    readState();
  }
}) as EventListener);
window.postMessage({ __spvgc: true, kind: "hello" }, location.origin);
window.dispatchEvent(new CustomEvent("spvg:req"));

chrome.runtime.onMessage.addListener((msg: Msg | { type: string }, _s, respond) => {
  if (msg.type === "discover-now" || msg.type === "reread-page") {
    void discover().then((info) => respond(info));
    return true;
  }
  if (msg.type === "progress") ui.progress((msg as Extract<Msg, { type: "progress" }>).progress);
  if (msg.type === "job-done") ui.done(msg as Extract<Msg, { type: "job-done" }>);
  return undefined;
});

window.addEventListener("load", () => {
  readState();
  setTimeout(schedulePush, 1000);
});
