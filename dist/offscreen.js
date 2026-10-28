"use strict";
(() => {
  // src/engine/sink.ts
  async function removeOpfsFile(fileName) {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(fileName).catch(() => void 0);
  }

  // src/offscreen.ts
  var jobs = /* @__PURE__ */ new Map();
  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.target !== "offscreen") return void 0;
    const id = msg.itemId ?? msg["spec"]?.itemId ?? "";
    if (msg.cmd === "has") {
      respond(jobs.has(id));
      return void 0;
    }
    if (msg.cmd === "cancel") {
      jobs.get(id)?.worker.postMessage({ cmd: "cancel" });
      respond(true);
      return void 0;
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
      return void 0;
    }
    if (msg.cmd === "start") {
      start(id, msg);
      respond(true);
    }
    return void 0;
  });
  function start(itemId, msg) {
    const worker = new Worker("mux-worker.js");
    const job = { worker };
    jobs.set(itemId, job);
    const fail = (error, cancelled = false) => {
      void chrome.runtime.sendMessage({ type: "job-done", itemId, sinkKind: "opfs", error: cancelled ? void 0 : error, cancelled });
      worker.terminate();
      jobs.delete(itemId);
    };
    worker.onmessage = async (e) => {
      const d = e.data;
      switch (d.kind) {
        case "progress":
          void chrome.runtime.sendMessage({ type: "progress", progress: d["progress"] });
          break;
        case "log":
          void chrome.runtime.sendMessage({ type: "log", level: "info", msg: String(d["msg"]) });
          break;
        case "refresh": {
          const c = await chrome.runtime.sendMessage({ type: "refresh", itemId }).catch(() => null);
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
            fail(err.message);
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
})();
