import { idbDelete, idbGet, idbSet } from "../shared/idb";
import { getHistory, getSettings, setSettings } from "../shared/storage";
import type { Settings } from "../types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
type Field = keyof Settings;

const text: Field[] = ["template", "subfolder", "transcriptSuffix", "transcriptGroupedSuffix"];
const selects: Field[] = ["mode", "quality", "transcriptFormat"];
const checks: Field[] = ["preferDirect", "retryOnFailure", "transcriptTimestamps", "captureFallback", "debug"];

async function load(): Promise<void> {
  const s = await getSettings();
  for (const k of [...text, ...selects]) $<HTMLInputElement>(k).value = String(s[k]);
  for (const k of checks) $<HTMLInputElement>(k).checked = Boolean(s[k]);
  $<HTMLSelectElement>("concurrency").value = String(s.concurrency);
  const dir = await idbGet<{ name: string }>("outputDir").catch(() => undefined);
  $("folderName").textContent = s.useFolderHandle && dir ? `Output folder: ${dir.name}` : "Output: browser Downloads folder";
}

function bind(): void {
  for (const k of [...text, ...selects]) $<HTMLInputElement>(k).addEventListener("change", (e) => void setSettings({ [k]: (e.target as HTMLInputElement).value }));
  for (const k of checks) $<HTMLInputElement>(k).addEventListener("change", (e) => void setSettings({ [k]: (e.target as HTMLInputElement).checked }));
  $<HTMLSelectElement>("concurrency").addEventListener("change", (e) => void setSettings({ concurrency: Number((e.target as HTMLSelectElement).value) as Settings["concurrency"] }));
}

async function renderHistory(): Promise<void> {
  const box = $("history");
  box.replaceChildren();
  const h = await getHistory();
  if (!h.length) box.textContent = "No downloads yet.";
  for (const e of h) {
    const d = document.createElement("div");
    d.className = "card";
    const a = document.createElement("div");
    a.textContent = e.filename;
    const b = document.createElement("div");
    b.className = "mu";
    b.textContent = `${new Date(e.ts).toLocaleString()} • ${e.source}`;
    d.append(a, b);
    box.append(d);
  }
}

async function showLog(): Promise<string> {
  const { debugLog = [] } = (await chrome.storage.local.get("debugLog")) as { debugLog?: string[] };
  $("log").textContent = debugLog.join("\n") || "(empty)";
  return debugLog.join("\n");
}

$("pick").onclick = async () => {
  try {
    const dir = await (window as unknown as { showDirectoryPicker(o: unknown): Promise<unknown> }).showDirectoryPicker({ mode: "readwrite" });
    await idbSet("outputDir", dir);
    await setSettings({ useFolderHandle: true });
    await load();
  } catch {
    /* cancelled */
  }
};
$("unpick").onclick = async () => {
  await idbDelete("outputDir");
  await setSettings({ useFolderHandle: false });
  await load();
};
$("showLog").onclick = () => void showLog();
$("exportLog").onclick = async () => {
  const t = await showLog();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([t], { type: "text/plain" }));
  a.download = "sp-video-grabber-log.txt";
  a.click();
};
$("clearLog").onclick = async () => {
  await chrome.storage.local.remove("debugLog");
  await showLog();
};
$("clearHistory").onclick = async () => {
  await chrome.storage.local.remove("history");
  await renderHistory();
};
$("ack").onclick = async () => {
  await chrome.storage.local.set({ firstRunAck: true });
  $("welcome").hidden = true;
};

void chrome.storage.local.get("firstRunAck").then((r) => {
  if (!r["firstRunAck"]) $("welcome").hidden = false;
});
bind();
void load();
void renderHistory();
