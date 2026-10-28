/** Offscreen document: hosts the mux worker and exposes finished OPFS files as blob URLs. */
import { removeOpfsFile } from "./engine/sink";
import type { Candidate } from "./types";

interface Job {
  worker: Worker;
  blobUrl?: string;
  opfsName?: string;
}
const jobs = new Map<string, Job>();

chrome.runtime.onMessage.addListener((msg: { target?: string; cmd?: string; itemId?: string; [k: string]: unknown }, _s, respond) => {
  if (msg.target !== "offscreen") return undefined;
  const id = msg.itemId ?? (msg["spec"] as { itemId: string } | undefined)?.itemId ?? "";
  if (msg.cmd === "has") {
    respond(jobs.has(id));
    return undefined;
  }
  if (msg.cmd === "cancel") {
    jobs.get(id)?.worker.postMessage({ cmd: "cancel" });
    respond(true);
    return undefined;
  }
  if (msg.cmd === "cleanup") {
    const j = jobs.get(id);
    if (j) {
      if (j.blobUrl) URL.revokeObjectURL(j.blobUrl);
      if (j.opfsName) void removeOpfsFile(j.opfsName);
      j.worker.terminate();
      jobs.delete(id);
    }
    respond(true);
    return undefined;
  }
  if (msg.cmd === "start") {
    start(id, msg);
    respond(true);
  }
  return undefined;
});

function start(itemId: string, msg: Record<string, unknown>): void {
  const worker = new Worker("mux-worker.js");
  const job: Job = { worker };
  jobs.set(itemId, job);
  const fail = (error: string, cancelled = false) => {
    void chrome.runtime.sendMessage({ type: "job-done", itemId, sinkKind: "opfs", error: cancelled ? undefined : error, cancelled });
    worker.terminate();
    jobs.delete(itemId);
  };
  worker.onmessage = async (e: MessageEvent) => {
    const d = e.data as { kind: string; [k: string]: unknown };
    switch (d.kind) {
      case "progress":
        void chrome.runtime.sendMessage({ type: "progress", progress: d["progress"] });
        break;
      case "log":
        void chrome.runtime.sendMessage({ type: "log", level: "info", msg: String(d["msg"]) });
        break;
      case "refresh": {
        const c = (await chrome.runtime.sendMessage({ type: "refresh", itemId }).catch(() => null)) as Candidate[] | null;
        worker.postMessage({ cmd: "refresh-result", reqId: d["reqId"], candidates: Array.isArray(c) ? c : null });
        break;
      }
      case "done": {
        if (d["sinkKind"] === "folder") {
          void chrome.runtime.sendMessage({ type: "job-done", itemId, sinkKind: "folder", filename: d["name"] });
          worker.terminate();
          jobs.delete(itemId);
          break;
        }
        try {
          const name = String(d["name"]);
          const root = await navigator.storage.getDirectory();
          const file = await (await root.getFileHandle(name)).getFile();
          job.opfsName = name;
          job.blobUrl = URL.createObjectURL(file);
          void chrome.runtime.sendMessage({ type: "job-done", itemId, sinkKind: "opfs", blobUrl: job.blobUrl, filename: name });
        } catch (err) {
          fail((err as Error).message);
        }
        break;
      }
      case "error":
        fail(String(d["error"]), d["cancelled"] === true);
        break;
    }
  };
  worker.onerror = (e) => fail(e.message || "worker crashed");
  worker.postMessage({ cmd: "start", spec: msg["spec"], base: msg["base"], useFolder: msg["useFolder"] });
}
