import { fmtBytes, fmtEta } from "../shared/storage";
import type { Candidate, Msg, PageInfo, Progress, QueueItem } from "../types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T = unknown>(m: Msg) => chrome.runtime.sendMessage(m) as Promise<T>;
const el = (tag: string, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

let tabId: number | undefined;

async function renderTab(): Promise<void> {
  const box = $("tab");
  box.replaceChildren();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (tabId === undefined) return;
  const { frames } = await send<{ frames: Record<string, PageInfo> }>({ type: "get-tab-state", tabId });
  const infos = Object.entries(frames).filter(([, f]) => f.candidates.length > 0);
  const card = el("div", "card");
  if (!infos.length) {
    card.append(el("div", "mu", "No stream detected on this tab yet. Open a video and let it load."));
    box.append(card);
    return;
  }
  for (const [frameId, info] of infos) {
    const streams: Candidate[] = info.candidates.filter((c) => c.kind !== "direct");
    card.append(el("div", "ell", info.title || "(untitled)"), el("div", "mu", `${streams.length} stream(s)${info.candidates.some((c) => c.kind === "direct") ? " • direct download available" : ""}`));
    const row = el("div", "row");
    const add = el("button", "p", "Add current video");
    add.onclick = async () => {
      const r = await send<{ error?: string }>({ type: "enqueue", item: { kind: "video", title: info.title, pageUrl: info.pageUrl, site: info.site, candidates: info.candidates, needsDiscovery: false, tabId, frameId: Number(frameId) } });
      if (r?.error) alert(r.error);
      void renderQueue();
    };
    row.append(add);
    card.append(row);
  }
  box.append(card);
}

function statusText(i: QueueItem): string {
  return i.status === "error" ? `error: ${i.error ?? ""}` : i.status;
}

async function renderQueue(): Promise<void> {
  const { queue, running } = await send<{ queue: QueueItem[]; running: boolean }>({ type: "queue-get" });
  $("start").toggleAttribute("disabled", running);
  $("stop").toggleAttribute("disabled", !running);
  const box = $("queue");
  box.replaceChildren();
  if (!queue.length) box.append(el("div", "mu", "The queue is empty."));
  queue.forEach((i) => {
    const c = el("div", "card");
    const top = el("div", "row");
    const title = el("div", "grow ell", i.title || i.pageUrl);
    title.title = i.pageUrl;
    top.append(title);
    const mk = (label: string, fn: () => Promise<unknown>) => {
      const b = el("button", "", label);
      b.onclick = () => void fn().then(renderQueue);
      return b;
    };
    top.append(mk("↑", () => send({ type: "queue-move", id: i.id, delta: -1 })), mk("↓", () => send({ type: "queue-move", id: i.id, delta: 1 })));
    if (i.status === "error" || i.status === "cancelled") top.append(mk("Retry", () => send({ type: "queue-retry", id: i.id })));
    top.append(mk(i.status === "running" ? "Cancel" : "Remove", () => send({ type: "queue-remove", id: i.id })));
    c.append(top, el("div", i.status === "error" ? "mu err" : "mu", `${statusText(i)}${i.outputName ? ` • ${i.outputName}` : ""}`));
    box.append(c);
  });
}

function showProgress(p: Progress): void {
  $("progress").textContent = `${p.phase} ${p.percent.toFixed(1)}% • ${fmtBytes(p.bytes)} • ${fmtBytes(p.speed)}/s • ETA ${fmtEta(p.eta)}`;
}

$("start").onclick = () => void send({ type: "queue-start" }).then(renderQueue);
$("stop").onclick = () => void send({ type: "queue-stop" }).then(renderQueue);
$("clear").onclick = () => void send({ type: "queue-clear-finished" }).then(renderQueue);
$("opts").onclick = () => void chrome.runtime.openOptionsPage();
$("pasteBtn").onclick = async () => {
  const input = $<HTMLInputElement>("paste");
  const url = input.value.trim();
  if (!url) return;
  const r = await send<{ error?: string }>({ type: "enqueue", item: { kind: "video", pageUrl: url, needsDiscovery: true }, start: true });
  if (r?.error) alert(r.error);
  else input.value = "";
  void renderQueue();
};

chrome.runtime.onMessage.addListener((m: { type?: string; progress?: Progress }) => {
  if (m.type === "progress" && m.progress) showProgress(m.progress);
  return undefined;
});
chrome.storage.onChanged.addListener((_c, area) => {
  if (area === "local") void renderQueue();
});
void renderTab();
void renderQueue();
void chrome.storage.session.get("progress").then((r) => r["progress"] && showProgress(r["progress"] as Progress));
