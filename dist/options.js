"use strict";
(() => {
  // src/shared/idb.ts
  var DB = "sp-video-grabber";
  var STORE = "kv";
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(key) {
    const db = await open();
    return new Promise((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function idbSet(key, value) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function idbDelete(key) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // src/types.ts
  var DEFAULT_SETTINGS = {
    mode: "av",
    quality: "best",
    concurrency: 4,
    template: "{title}",
    subfolder: "",
    useFolderHandle: false,
    retryOnFailure: false,
    preferDirect: true,
    transcriptFormat: "vtt",
    transcriptTimestamps: true,
    transcriptSuffix: "_transcript",
    transcriptGroupedSuffix: "_transcript_grouped",
    captureFallback: false,
    debug: false
  };

  // src/shared/storage.ts
  async function getSettings() {
    const s = await chrome.storage.sync.get(null);
    return { ...DEFAULT_SETTINGS, ...s };
  }
  async function setSettings(patch) {
    await chrome.storage.sync.set(patch);
  }
  async function getHistory() {
    const { history = [] } = await chrome.storage.local.get("history");
    return history;
  }

  // src/pages/options.ts
  var $ = (id) => document.getElementById(id);
  var text = ["template", "subfolder", "transcriptSuffix", "transcriptGroupedSuffix"];
  var selects = ["mode", "quality", "transcriptFormat"];
  var checks = ["preferDirect", "retryOnFailure", "transcriptTimestamps", "captureFallback", "debug"];
  async function load() {
    const s = await getSettings();
    for (const k of [...text, ...selects]) $(k).value = String(s[k]);
    for (const k of checks) $(k).checked = Boolean(s[k]);
    $("concurrency").value = String(s.concurrency);
    const dir = await idbGet("outputDir").catch(() => void 0);
    $("folderName").textContent = s.useFolderHandle && dir ? `Output folder: ${dir.name}` : "Output: browser Downloads folder";
  }
  function bind() {
    for (const k of [...text, ...selects]) $(k).addEventListener("change", (e) => void setSettings({ [k]: e.target.value }));
    for (const k of checks) $(k).addEventListener("change", (e) => void setSettings({ [k]: e.target.checked }));
    $("concurrency").addEventListener("change", (e) => void setSettings({ concurrency: Number(e.target.value) }));
  }
  async function renderHistory() {
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
      b.textContent = `${new Date(e.ts).toLocaleString()} \u2022 ${e.source}`;
      d.append(a, b);
      box.append(d);
    }
  }
  async function showLog() {
    const { debugLog = [] } = await chrome.storage.local.get("debugLog");
    $("log").textContent = debugLog.join("\n") || "(empty)";
    return debugLog.join("\n");
  }
  $("pick").onclick = async () => {
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite" });
      await idbSet("outputDir", dir);
      await setSettings({ useFolderHandle: true });
      await load();
    } catch {
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
})();
