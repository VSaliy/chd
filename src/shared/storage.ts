import { DEFAULT_SETTINGS, type HistoryEntry, type Settings } from "../types";

export async function getSettings(): Promise<Settings> {
  const s = (await chrome.storage.sync.get(null)) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

export async function addHistory(e: HistoryEntry): Promise<void> {
  const { history = [] } = (await chrome.storage.local.get("history")) as { history?: HistoryEntry[] };
  history.unshift(e);
  await chrome.storage.local.set({ history: history.slice(0, 500) });
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const { history = [] } = (await chrome.storage.local.get("history")) as { history?: HistoryEntry[] };
  return history;
}

export function send<T = unknown>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function log(level: "info" | "warn" | "error", msg: string): void {
  void chrome.runtime.sendMessage({ type: "log", level, msg }).catch(() => undefined);
}

export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtEta(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "--:--";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(Math.floor(s % 60))}` : `${p(m)}:${p(Math.floor(s % 60))}`;
}
