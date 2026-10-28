/** Dedicated worker: runs the download engine and writes to the sink. */
import { runDownload, type JobSpec } from "./engine/download";
import { getOutputDir, openFolderSink, openOpfsSink } from "./engine/sink";
import type { Candidate } from "./types";

interface StartMsg {
  cmd: "start";
  spec: JobSpec;
  base: string;
  useFolder: boolean;
}

const ctl = new AbortController();
const pending = new Map<number, (c: Candidate[] | null) => void>();
let reqId = 0;

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as StartMsg | { cmd: "cancel" } | { cmd: "refresh-result"; reqId: number; candidates: Candidate[] | null };
  if (m.cmd === "cancel") return ctl.abort();
  if (m.cmd === "refresh-result") {
    pending.get(m.reqId)?.(m.candidates);
    pending.delete(m.reqId);
    return;
  }
  const { spec, base, useFolder } = m;
  try {
    const res = await runDownload(spec, base, {
      signal: ctl.signal,
      progress: (progress) => self.postMessage({ kind: "progress", progress }),
      log: (msg) => self.postMessage({ kind: "log", msg }),
      refresh: () =>
        new Promise((resolve) => {
          const id = ++reqId;
          pending.set(id, resolve);
          self.postMessage({ kind: "refresh", reqId: id });
        }),
      openSink: async (ext) => {
        if (useFolder) {
          const dir = await getOutputDir();
          if (dir) return openFolderSink(dir, base, ext);
        }
        return openOpfsSink(`${spec.itemId}${ext}`);
      },
    });
    self.postMessage({ kind: "done", name: res.name, sinkKind: res.sink.kind });
  } catch (err) {
    const e2 = err as Error;
    self.postMessage({ kind: "error", error: e2.message ?? String(err), cancelled: e2.name === "AbortError" || ctl.signal.aborted });
  }
};
