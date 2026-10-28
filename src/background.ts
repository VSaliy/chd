/** Service worker: queue, context menu, downloads and offscreen coordination. */
import { applyTemplate, uniqueName } from "./lib/filename";
import { isAllowedUrl, regexEscape, sanitizeSubfolder } from "./lib/hosts";
import { parseMpd, describeRepresentation } from "./lib/mpd";
import { fetchWithRetry } from "./lib/retry";
import { addHistory, getSettings } from "./shared/storage";
import type { Candidate, Mode, Msg, PageInfo, Progress, QueueItem, RepInfo, Settings } from "./types";

type Active =
  | { kind: "prep"; itemId: string }
  | { kind: "offscreen"; itemId: string; base: string; ext: string }
  | { kind: "save"; itemId: string; downloadId: number }
  | { kind: "direct"; itemId: string; downloadId: number };

interface TabState {
  frames: Record<number, PageInfo>;
}

const tabStates = new Map<number, TabState>();
let progressPct: number | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;

/* ---------- storage helpers ---------- */

let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = lock.then(fn, fn);
  lock = p.catch(() => undefined);
  return p;
}
const readQueue = async (): Promise<QueueItem[]> => ((await chrome.storage.local.get("queue")) as { queue?: QueueItem[] }).queue ?? [];
const writeQueue = (queue: QueueItem[]) => chrome.storage.local.set({ queue });
const isRunning = async (): Promise<boolean> => !!((await chrome.storage.local.get("queueRunning")) as { queueRunning?: boolean }).queueRunning;
const getActive = async (): Promise<Active | null> => ((await chrome.storage.session.get("active")) as { active?: Active }).active ?? null;
const setActive = (active: Active | null) => (active ? chrome.storage.session.set({ active }) : chrome.storage.session.remove("active"));

async function mutateItem(id: string, fn: (i: QueueItem) => void): Promise<QueueItem | undefined> {
  return withLock(async () => {
    const q = await readQueue();
    const it = q.find((x) => x.id === id);
    if (!it) return undefined;
    fn(it);
    await writeQueue(q);
    return it;
  });
}

async function dlog(level: "info" | "warn" | "error", msg: string): Promise<void> {
  const s = await getSettings();
  if (!s.debug) return;
  const { debugLog = [] } = (await chrome.storage.local.get("debugLog")) as { debugLog?: string[] };
  debugLog.push(`${new Date().toISOString()} [${level}] ${msg}`);
  await chrome.storage.local.set({ debugLog: debugLog.slice(-500) });
}

/* ---------- tab state + badge ---------- */

async function persistTabs(): Promise<void> {
  await chrome.storage.session.set({ tabStates: Object.fromEntries(tabStates) });
}

function streamsOf(tabId: number): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const f of Object.values(tabStates.get(tabId)?.frames ?? {})) for (const c of f.candidates) if (c.kind !== "direct" && !seen.has(c.url)) (seen.add(c.url), out.push(c));
  return out;
}

function renderBadge(tabId: number): void {
  const text = progressPct !== null ? `${Math.round(progressPct)}%` : streamsOf(tabId).length ? String(streamsOf(tabId).length) : "";
  void chrome.action.setBadgeBackgroundColor({ tabId, color: progressPct !== null ? "#0f6cbd" : "#107c10" }).catch(() => undefined);
  void chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
}
function renderAllBadges(): void {
  for (const id of tabStates.keys()) renderBadge(id);
  void chrome.action.setBadgeBackgroundColor({ color: "#0f6cbd" });
  void chrome.action.setBadgeText({ text: progressPct !== null ? `${Math.round(progressPct)}%` : "" });
}

/* ---------- validation ---------- */

function cleanCandidates(c: Candidate[] | undefined): Candidate[] {
  return (c ?? []).filter((x) => isAllowedUrl(x.url));
}

/* ---------- queue ---------- */

function qualityToken(q: string): string {
  return q === "best" ? "best" : /^\d+$/.test(q) ? `${q}p` : q;
}

async function enqueueItems(partials: Array<Partial<QueueItem> & Pick<QueueItem, "pageUrl">>, sender?: chrome.runtime.MessageSender): Promise<string[] | { error: string }> {
  const s = await getSettings();
  const items: QueueItem[] = [];
  for (const p of partials) {
    if (!isAllowedUrl(p.pageUrl)) return { error: "This URL is not on a supported SharePoint/Teams host." };
    const candidates = cleanCandidates(p.candidates);
    items.push({
      id: crypto.randomUUID(),
      kind: p.kind ?? "video",
      title: p.title ?? "",
      pageUrl: p.pageUrl,
      site: p.site ?? "",
      mode: p.mode ?? s.mode,
      quality: p.quality ?? s.quality,
      status: "queued",
      needsDiscovery: p.needsDiscovery ?? candidates.length === 0,
      candidates,
      tabId: p.tabId ?? sender?.tab?.id,
      frameId: p.frameId ?? sender?.frameId,
      attempts: 0,
      addedAt: Date.now(),
    });
  }
  await withLock(async () => {
    const q = await readQueue();
    const active = q.filter((i) => i.status === "queued" || i.status === "running");
    const rest = q.filter((i) => !(i.status === "queued" || i.status === "running"));
    await writeQueue([...active, ...items, ...rest]);
  });
  return items.map((i) => i.id);
}

async function setRunning(on: boolean): Promise<void> {
  await chrome.storage.local.set({ queueRunning: on });
  if (on) void pump();
}

let pumping = false;
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    if (!(await isRunning()) || (await getActive())) return;
    const item = await withLock(async () => {
      const q = await readQueue();
      if (q.some((i) => i.status === "running")) return undefined;
      const next = q.find((i) => i.status === "queued");
      if (next) {
        next.status = "running";
        next.error = undefined;
        await writeQueue(q);
      }
      return next;
    });
    if (!item) {
      progressPct = null;
      renderAllBadges();
      return;
    }
    await setActive({ kind: "prep", itemId: item.id });
    void startItem(item);
  } finally {
    pumping = false;
  }
}

async function finishItem(id: string, outcome: { error?: string; cancelled?: boolean; filename?: string }): Promise<void> {
  await setActive(null);
  clearInterval(pollTimer);
  const s = await getSettings();
  await withLock(async () => {
    const q = await readQueue();
    const i = q.findIndex((x) => x.id === id);
    if (i < 0) return;
    const it = q[i] as QueueItem;
    if (outcome.cancelled) q.splice(i, 1);
    else if (outcome.error) {
      it.attempts++;
      it.error = outcome.error;
      if (s.retryOnFailure && it.attempts < 3) {
        it.status = "queued";
        q.splice(i, 1);
        q.push(it);
      } else it.status = "error";
    } else {
      it.status = "done";
      it.outputName = outcome.filename;
      q.splice(i, 1);
      q.push(it);
    }
    await writeQueue(q);
  });
  const it = (await readQueue()).find((x) => x.id === id);
  if (it?.tabId !== undefined) void chrome.tabs.sendMessage(it.tabId, { type: "job-done", itemId: id, filename: outcome.filename, error: outcome.error, cancelled: outcome.cancelled, sinkKind: "opfs" }).catch(() => undefined);
  progressPct = null;
  renderAllBadges();
  await dlog(outcome.error ? "error" : "info", `Item ${id} finished: ${outcome.error ?? outcome.cancelled ? outcome.error ?? "cancelled" : outcome.filename}`);
  void pump();
}

/* ---------- discovery in tabs ---------- */

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function tabAlive(id: number | undefined): Promise<boolean> {
  if (id === undefined) return false;
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

async function discoverInNewTab(url: string, timeoutMs = 60000): Promise<PageInfo | null> {
  const tab = await chrome.tabs.create({ url, active: false });
  const id = tab.id as number;
  try {
    const t0 = Date.now();
    let frameId = -1;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1000);
      const fr = Object.entries(tabStates.get(id)?.frames ?? {}).find(([, f]) => f.candidates.length > 0);
      if (fr) {
        frameId = Number(fr[0]);
        break;
      }
    }
    if (frameId < 0) frameId = 0;
    return await new Promise<PageInfo | null>((resolve) => {
      chrome.tabs.sendMessage(id, { type: "discover-now" }, { frameId }, (r: PageInfo | undefined) => resolve(chrome.runtime.lastError ? null : (r ?? null)));
    });
  } finally {
    await chrome.tabs.remove(id).catch(() => undefined);
    tabStates.delete(id);
  }
}

async function freshInfo(item: QueueItem, forceNew: boolean): Promise<PageInfo | null> {
  if (!forceNew && item.needsDiscovery === false && item.candidates.length && (await tabAlive(item.tabId))) return null;
  if (item.tabId !== undefined && (await tabAlive(item.tabId))) {
    const info = await new Promise<PageInfo | null>((resolve) => {
      chrome.tabs.sendMessage(item.tabId as number, { type: "reread-page" }, { frameId: item.frameId ?? 0 }, (r: PageInfo | undefined) => resolve(chrome.runtime.lastError ? null : (r ?? null)));
    });
    const old = new Set(item.candidates.map((c) => c.url));
    if (info && info.candidates.some((c) => c.kind !== "direct" && !old.has(c.url))) return info;
  }
  return discoverInNewTab(item.pageUrl);
}

/* ---------- running an item ---------- */

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS], justification: "Download, decrypt and mux video segments off the service worker" });
}

async function existingNames(subfolder: string, base: string): Promise<string[]> {
  const names: string[] = [];
  const found = await chrome.downloads.search({ query: [base], exists: true, limit: 1000 }).catch(() => []);
  for (const d of found) names.push(d.filename.split(/[\\/]/).pop() ?? "");
  const { history = [] } = (await chrome.storage.local.get("history")) as { history?: Array<{ filename: string }> };
  for (const h of history) if (h.filename.startsWith(subfolder ? `${subfolder}/` : "")) names.push(h.filename.split("/").pop() ?? "");
  return names;
}

async function outputPath(base: string, ext: string, s: Settings): Promise<string> {
  const sub = sanitizeSubfolder(s.subfolder);
  const name = uniqueName(base, ext, await existingNames(sub, base));
  return sub ? `${sub}/${name}` : name;
}

async function startItem(item: QueueItem): Promise<void> {
  try {
    const s = await getSettings();
    let it = item;
    if (it.needsDiscovery || !it.candidates.length) {
      const info = await discoverInNewTab(it.pageUrl);
      if (!info || !info.candidates.length) throw new Error("No stream could be discovered for this page.");
      it = (await mutateItem(it.id, (x) => {
        x.candidates = cleanCandidates(info.candidates);
        x.needsDiscovery = false;
        x.title ||= info.title;
        x.site ||= info.site;
      })) as QueueItem;
    }
    if (!(await withLock(readQueue)).some((x) => x.id === it.id && x.status === "running")) return; // cancelled while preparing
    const itemIdShort = it.id.slice(0, 8);
    const base = applyTemplate(s.template, { title: it.title, site: it.site, quality: qualityToken(it.quality), id: itemIdShort });
    const direct = it.candidates.find((c) => c.kind === "direct");
    if (direct && s.preferDirect && it.mode === "av" && it.quality === "best") {
      const ext = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(new URL(direct.url).pathname)?.[1] ?? "mp4";
      const filename = await outputPath(base, `.${ext.toLowerCase()}`, s);
      const downloadId = await chrome.downloads.download({ url: direct.url, filename, conflictAction: "uniquify" });
      await setActive({ kind: "direct", itemId: it.id, downloadId });
      watchDownload(it.id, downloadId, filename, true);
      return;
    }
    const mode: Mode = it.mode;
    const ext = mode === "audio" ? ".m4a" : ".mp4";
    await ensureOffscreen();
    await setActive({ kind: "offscreen", itemId: it.id, base, ext });
    await chrome.runtime.sendMessage({
      target: "offscreen",
      cmd: "start",
      spec: { itemId: it.id, candidates: cleanCandidates(it.candidates), mode, quality: it.quality, concurrency: s.concurrency },
      base,
      useFolder: s.useFolderHandle,
    });
  } catch (e) {
    await finishItem(item.id, { error: (e as Error).message });
  }
}

function watchDownload(itemId: string, downloadId: number, filename: string, report: boolean): void {
  clearInterval(pollTimer);
  const check = async () => {
    const [d] = await chrome.downloads.search({ id: downloadId });
    if (!d) return;
    if (report && d.state === "in_progress") {
      const pct = d.totalBytes > 0 ? (d.bytesReceived / d.totalBytes) * 100 : 0;
      onProgress({ itemId, percent: pct, bytes: d.bytesReceived, speed: 0, eta: Infinity, phase: "Downloading" });
    }
    if (d.state === "complete") await onSaved(itemId, downloadId, d.filename ? filename : filename);
    else if (d.state === "interrupted") await onSaveFailed(itemId, downloadId, d.error ?? "interrupted");
  };
  pollTimer = setInterval(() => void check(), 1000);
}

const claimed = new Set<string>();

async function onSaved(itemId: string, downloadId: number, filename: string): Promise<void> {
  const a = await getActive();
  if (!a || a.itemId !== itemId || claimed.has(itemId)) return;
  claimed.add(itemId);
  clearInterval(pollTimer);
  const it = (await readQueue()).find((x) => x.id === itemId);
  await addHistory({ ts: Date.now(), filename, source: it?.pageUrl ?? "" });
  if (a.kind === "save") void chrome.runtime.sendMessage({ target: "offscreen", cmd: "cleanup", itemId }).catch(() => undefined);
  void downloadId;
  await finishItem(itemId, { filename });
}

async function onSaveFailed(itemId: string, _downloadId: number, error: string): Promise<void> {
  if (claimed.has(itemId)) return;
  claimed.add(itemId);
  clearInterval(pollTimer);
  void chrome.runtime.sendMessage({ target: "offscreen", cmd: "cleanup", itemId }).catch(() => undefined);
  await finishItem(itemId, { error: `Saving failed: ${error}` });
}

function onProgress(p: Progress): void {
  progressPct = p.percent;
  renderAllBadges();
  void chrome.storage.session.set({ progress: p });
  void readQueue().then((q) => {
    const tab = q.find((x) => x.id === p.itemId)?.tabId;
    if (tab !== undefined) void chrome.tabs.sendMessage(tab, { type: "progress", progress: p }).catch(() => undefined);
  });
}

async function handleJobDone(m: Extract<Msg, { type: "job-done" }>): Promise<void> {
  const a = await getActive();
  if (!a || a.itemId !== m.itemId || a.kind !== "offscreen") return;
  if (m.cancelled) return finishItem(m.itemId, { cancelled: true });
  if (m.error) return finishItem(m.itemId, { error: m.error });
  const s = await getSettings();
  if (m.sinkKind === "folder") {
    const it = (await readQueue()).find((x) => x.id === m.itemId);
    await addHistory({ ts: Date.now(), filename: m.filename ?? a.base + a.ext, source: it?.pageUrl ?? "" });
    return finishItem(m.itemId, { filename: m.filename });
  }
  const filename = await outputPath(a.base, a.ext, s);
  try {
    const downloadId = await chrome.downloads.download({ url: m.blobUrl as string, filename, conflictAction: "uniquify" });
    await setActive({ kind: "save", itemId: m.itemId, downloadId });
    watchDownload(m.itemId, downloadId, filename, false);
  } catch (e) {
    await finishItem(m.itemId, { error: `Saving failed: ${(e as Error).message}` });
  }
}

async function cancelItem(id: string): Promise<void> {
  const a = await getActive();
  if (a && a.itemId === id) {
    if (a.kind === "offscreen") {
      void chrome.runtime.sendMessage({ target: "offscreen", cmd: "cancel", itemId: id }).catch(() => undefined);
      return; // finishItem runs when the worker reports back
    }
    if (a.kind === "direct" || a.kind === "save") {
      await chrome.downloads.cancel(a.downloadId).catch(() => undefined);
      await chrome.downloads.removeFile(a.downloadId).catch(() => undefined);
    }
    await finishItem(id, { cancelled: true });
    return;
  }
  await withLock(async () => writeQueue((await readQueue()).filter((x) => x.id !== id)));
}

async function saveText(m: Extract<Msg, { type: "save-text" }>): Promise<{ filename: string }> {
  const s = await getSettings();
  const dot = m.filename.lastIndexOf(".");
  const base = dot > 0 ? m.filename.slice(0, dot) : m.filename;
  const ext = dot > 0 ? m.filename.slice(dot) : "";
  const filename = await outputPath(base, ext, s);
  const url = `data:${m.mime};charset=utf-8,${encodeURIComponent(m.text)}`;
  await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
  await addHistory({ ts: Date.now(), filename, source: m.source });
  return { filename };
}

async function inspect(c: Candidate): Promise<{ reps?: RepInfo[]; error?: string }> {
  if (!isAllowedUrl(c.url)) return { error: "blocked host" };
  try {
    const h: Record<string, string> = {};
    if (c.headers?.authorization) h["Authorization"] = c.headers.authorization;
    if (c.headers?.spopactoken) h["x-spopactoken"] = c.headers.spopactoken;
    const r = await fetchWithRetry(c.url, { credentials: "include", headers: h }, { maxAttempts: 3 });
    const mpd = parseMpd(await r.text(), c.url);
    return { reps: mpd.representations.map((x) => ({ id: x.id, kind: x.kind, label: describeRepresentation(x), height: x.height, bandwidth: x.bandwidth })) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/* ---------- reconcile after service worker restart ---------- */

const ready: Promise<void> = (async () => {
  const { tabStates: saved } = (await chrome.storage.session.get("tabStates")) as { tabStates?: Record<string, TabState> };
  for (const [k, v] of Object.entries(saved ?? {})) tabStates.set(Number(k), v);
  const a = await getActive();
  let alive = false;
  if (a?.kind === "offscreen") {
    alive = (await chrome.offscreen.hasDocument()) && !!(await chrome.runtime.sendMessage({ target: "offscreen", cmd: "has", itemId: a.itemId }).catch(() => false));
  } else if (a?.kind === "direct" || a?.kind === "save") {
    const [d] = await chrome.downloads.search({ id: a.downloadId });
    alive = d?.state === "in_progress";
    if (alive) watchDownload(a.itemId, a.downloadId, (d as chrome.downloads.DownloadItem).filename, a.kind === "direct");
  }
  if (!alive) {
    await setActive(null);
    await withLock(async () => {
      const q = await readQueue();
      for (const i of q) if (i.status === "running") i.status = "queued";
      await writeQueue(q);
    });
  }
  void pump();
})();

/* ---------- events ---------- */

chrome.runtime.onInstalled.addListener((d) => {
  chrome.contextMenus.create({
    id: "spvg-link",
    title: "Download with SP Video Grabber",
    contexts: ["link"],
    targetUrlPatterns: ["https://*.sharepoint.com/*", "https://*.sharepoint.com.mcas.ms/*", "https://teams.microsoft.com/*", "https://teams.cloud.microsoft/*", "https://teams.microsoft.com.mcas.ms/*"],
  });
  if (d.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#welcome") });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "spvg-link" || !info.linkUrl) return;
  void ready.then(async () => {
    const r = await enqueueItems([{ pageUrl: info.linkUrl as string, needsDiscovery: true }]);
    if (!("error" in r)) await setRunning(true);
  });
});

chrome.tabs.onRemoved.addListener((id) => {
  tabStates.delete(id);
  void persistTabs();
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "loading" && tabStates.delete(id)) {
    void persistTabs();
    renderBadge(id);
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  void ready.then(async () => {
    const a = await getActive();
    if (!a || (a.kind !== "save" && a.kind !== "direct") || a.downloadId !== delta.id) return;
    const [d] = await chrome.downloads.search({ id: delta.id });
    if (!d) return;
    const rel = d.filename.replace(/\\/g, "/");
    const s = await getSettings();
    const sub = sanitizeSubfolder(s.subfolder);
    const shown = sub && rel.includes(`/${sub}/`) ? rel.slice(rel.lastIndexOf(`/${sub}/`) + 1) : (rel.split("/").pop() ?? rel);
    if (delta.state?.current === "complete") await onSaved(a.itemId, a.downloadId, shown);
    else if (delta.state?.current === "interrupted") await onSaveFailed(a.itemId, a.downloadId, d.error ?? "interrupted");
  });
});

chrome.runtime.onMessage.addListener((raw: Msg & { target?: string }, sender, respond) => {
  if (raw.target === "offscreen") return undefined;
  const m = raw as Msg;
  const run = async (): Promise<unknown> => {
    await ready;
    switch (m.type) {
      case "page-info": {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return;
        const st = tabStates.get(tabId) ?? { frames: {} };
        st.frames[sender.frameId ?? 0] = { ...m.info, candidates: cleanCandidates(m.info.candidates) };
        tabStates.set(tabId, st);
        await persistTabs();
        renderBadge(tabId);
        return;
      }
      case "get-tab-state":
        return { frames: tabStates.get(m.tabId)?.frames ?? {} };
      case "enqueue": {
        const r = await enqueueItems([m.item], sender);
        if ("error" in r) return r;
        if (m.start) await setRunning(true);
        return { id: r[0] };
      }
      case "enqueue-many": {
        const r = await enqueueItems(m.items, sender);
        return "error" in r ? r : { ids: r };
      }
      case "queue-get":
        return { queue: await readQueue(), running: await isRunning() };
      case "queue-remove":
        return cancelItem(m.id);
      case "queue-move":
        return withLock(async () => {
          const q = await readQueue();
          const i = q.findIndex((x) => x.id === m.id);
          const j = i + m.delta;
          if (i < 0 || j < 0 || j >= q.length) return;
          const [it] = q.splice(i, 1);
          q.splice(j, 0, it as QueueItem);
          await writeQueue(q);
        });
      case "queue-retry":
        await mutateItem(m.id, (i) => {
          i.status = "queued";
          i.error = undefined;
        });
        return void pump();
      case "queue-clear-finished":
        return withLock(async () => writeQueue((await readQueue()).filter((i) => i.status === "queued" || i.status === "running")));
      case "queue-start":
        return setRunning(true);
      case "queue-stop":
        await chrome.storage.local.set({ queueRunning: false });
        return;
      case "inspect":
        return inspect(m.candidate);
      case "save-text":
        return saveText(m);
      case "log":
        return dlog(m.level, m.msg);
      case "progress":
        return onProgress(m.progress);
      case "job-done":
        return handleJobDone(m);
      case "refresh": {
        const it = (await readQueue()).find((x) => x.id === m.itemId);
        if (!it) return null;
        const info = await freshInfo(it, true);
        if (!info) return null;
        const c = cleanCandidates(info.candidates);
        await mutateItem(it.id, (x) => (x.candidates = c));
        return c;
      }
      default:
        return undefined;
    }
  };
  run().then(respond, (e: Error) => respond({ error: e.message }));
  return true;
});

chrome.runtime.onStartup.addListener(() => void ready);
void regexEscape;
