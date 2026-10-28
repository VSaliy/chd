/** Floating widget, modals and command-bar button (shadow DOM, no frameworks). */
import { applyTemplate } from "./lib/filename";
import { convertTranscript, TRANSCRIPT_EXT, transcriptSuffix, type TranscriptFormat } from "./lib/transcript";
import { ffmpegCommand, TOKEN_WARNING, ytDlpCommand } from "./lib/commands";
import { filesUrl, filterAndSortVideos, foldersUrl, folderRefFromUrl, isFolderShareLink, streamPageUrl, type FolderFile, type FolderRef, type SortKey } from "./lib/folderUrl";
import { fetchWithRetry } from "./lib/retry";
import { fmtBytes, fmtEta, getSettings, setSettings } from "./shared/storage";
import type { Candidate, Mode, Msg, PageInfo, Progress, RepInfo } from "./types";

interface Deps {
  discover(): Promise<PageInfo>;
  getTranscriptJson(): Promise<unknown>;
  getInfo(): PageInfo;
}

export interface Ui {
  update(info: PageInfo): void;
  progress(p: Progress): void;
  done(m: Extract<Msg, { type: "job-done" }>): void;
}

const CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:Segoe UI,system-ui,sans-serif;font-size:13px}
.w{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:6px;align-items:center;padding:8px;border-radius:10px;
 background:var(--bg);color:var(--fg);box-shadow:0 4px 18px rgba(0,0,0,.35);border:1px solid var(--bd)}
:host{--bg:#fff;--fg:#1b1b1b;--bd:#d0d0d0;--ac:#0f6cbd;--mu:#666}
@media (prefers-color-scheme:dark){:host{--bg:#2b2b2b;--fg:#f0f0f0;--bd:#444;--ac:#479ef5;--mu:#aaa}}
button,select,input[type=text]{background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:5px 9px;cursor:pointer}
button.p{background:var(--ac);color:#fff;border-color:var(--ac)}
button:disabled{opacity:.5;cursor:default}
.grp{display:flex}.grp button:first-child{border-top-right-radius:0;border-bottom-right-radius:0}
.grp button:last-child{border-top-left-radius:0;border-bottom-left-radius:0;border-left:0}
.menu{position:absolute;bottom:100%;right:0;margin-bottom:6px;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:4px;min-width:220px}
.bd{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:2147483647}
.m{background:var(--bg);color:var(--fg);border-radius:10px;padding:16px;min-width:360px;max-width:560px;max-height:80vh;overflow:auto;border:1px solid var(--bd)}
.m h3{margin:0 0 10px;font-size:15px}.row{display:flex;gap:8px;align-items:center;margin:6px 0}.row.end{justify-content:flex-end}
.mu{color:var(--mu);font-size:12px}.warn{color:#c50f1f}
progress{width:100%}
label.i{display:flex;gap:6px;align-items:center}
`;

type El = HTMLElement;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (string | Node)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = String(v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, String(v));
  }
  e.append(...kids);
  return e;
}

export function mountUi(deps: Deps): Ui {
  let info: PageInfo | null = null;
  let host: El | null = null;
  let root: ShadowRoot | null = null;
  let widget: El | null = null;
  let modalProgress: { itemId: string; box: El } | null = null;
  const isFolder = () => isFolderShareLink(location.href) || (/onedrive\.aspx/i.test(location.pathname) && !!new URL(location.href).searchParams.get("id") && !/\.[a-z0-9]{2,4}$/i.test(new URL(location.href).searchParams.get("id") ?? ""));

  const ensureHost = (): ShadowRoot | null => {
    if (root) return root;
    if (!document.documentElement) return null;
    host = h("div", { id: "spvg-host" });
    root = host.attachShadow({ mode: "open" });
    root.append(h("style", {}, CSS));
    document.documentElement.append(host);
    return root;
  };

  const toast = (msg: string, bad = false) => {
    const r = ensureHost();
    if (!r) return;
    const t = h("div", { class: "w", style: "bottom:80px" }, h("span", { class: bad ? "warn" : "" }, msg));
    r.append(t);
    setTimeout(() => t.remove(), 4500);
  };

  async function baseName(): Promise<string> {
    const s = await getSettings();
    const i = deps.getInfo();
    return applyTemplate(s.template, { title: i.title, site: i.site, id: i.fileInfo.itemId?.slice(0, 8) ?? "" });
  }

  async function downloadTranscript(format?: TranscriptFormat): Promise<void> {
    try {
      const s = await getSettings();
      const fmt = format ?? s.transcriptFormat;
      const json = await deps.getTranscriptJson();
      const text = convertTranscript(json, fmt, s.transcriptTimestamps);
      const name = (await baseName()) + transcriptSuffix(fmt, { plain: s.transcriptSuffix, grouped: s.transcriptGroupedSuffix }) + TRANSCRIPT_EXT[fmt];
      await chrome.runtime.sendMessage({ type: "save-text", filename: name, text, mime: { json: "application/json", vtt: "text/vtt", srt: "application/x-subrip", txt: "text/plain" }[fmt], source: location.href } satisfies Msg);
      toast(`Transcript saved: ${name}`);
    } catch (e) {
      toast(`Transcript failed: ${(e as Error).message}`, true);
    }
  }

  function modal(title: string, body: Node[], actions: Node[]): { close(): void; el: El } {
    const r = ensureHost()!;
    const close = () => bd.remove();
    const bd = h("div", { class: "bd", onclick: (e: Event) => e.target === bd && close() }, h("div", { class: "m" }, h("h3", {}, title), ...body, h("div", { class: "row end" }, ...actions)));
    r.append(bd);
    return { close, el: bd };
  }

  async function enqueue(extra: Record<string, unknown>, start: boolean): Promise<string | undefined> {
    const i = await deps.discover();
    const s = await getSettings();
    const res = (await chrome.runtime.sendMessage({
      type: "enqueue",
      start,
      item: { kind: "video", title: i.title, pageUrl: i.pageUrl, site: i.site, mode: s.mode, quality: s.quality, candidates: i.candidates, needsDiscovery: false, ...extra },
    } satisfies Msg)) as { id?: string; error?: string };
    if (res?.error) toast(res.error, true);
    return res?.id;
  }

  async function quickDownload(): Promise<void> {
    const i = await deps.discover();
    if (!i.candidates.length) return toast("No stream found yet. Press play on the video and try again.", true);
    const id = await enqueue({}, true);
    if (id) toast("Download started. Progress is shown in the toolbar badge and popup.");
  }

  async function chooseDialog(): Promise<void> {
    const i = await deps.discover();
    const s = await getSettings();
    const cand = i.candidates.find((c) => c.kind !== "direct");
    let reps: RepInfo[] = [];
    const status = h("div", { class: "mu" }, "Reading stream info...");
    const mode = h("select", {}, h("option", { value: "av" }, "Video + audio (.mp4)"), h("option", { value: "video" }, "Video only (.mp4)"), h("option", { value: "audio" }, "Audio only (.m4a)"));
    mode.value = s.mode;
    const quality = h("select", {}, h("option", { value: "best" }, "Best"), h("option", { value: "1080" }, "Up to 1080p"), h("option", { value: "720" }, "Up to 720p"));
    quality.value = ["best", "1080", "720"].includes(s.quality) ? s.quality : "best";
    const box = h("div", {});
    const go = h("button", { class: "p" }, "Download");
    const cancel = h("button", {}, "Close");
    const add = h("button", {}, "Add to queue");
    const m = modal("Download video", [h("div", { class: "row" }, "Mode", mode), h("div", { class: "row" }, "Quality", quality), status, box], [cancel, add, go]);
    cancel.addEventListener("click", m.close);
    if (cand) {
      void (chrome.runtime.sendMessage({ type: "inspect", candidate: cand } satisfies Msg) as Promise<{ reps?: RepInfo[]; error?: string }>).then((r) => {
        if (r?.reps) {
          reps = r.reps.filter((x) => x.kind === "video");
          for (const v of reps) quality.append(h("option", { value: v.id }, `Only: ${v.label}`));
          status.textContent = `${reps.length} video quality option(s) found.`;
        } else status.textContent = `Could not read the manifest (${r?.error ?? "unknown error"}). Presets still work.`;
      });
    } else status.textContent = "Direct file download will be used when available.";
    const run = async (start: boolean) => {
      const id = await enqueue({ mode: mode.value as Mode, quality: quality.value }, start);
      if (!id) return;
      if (!start) {
        toast("Added to queue");
        m.close();
        return;
      }
      go.disabled = add.disabled = true;
      const bar = h("progress", { max: 100, value: 0 });
      const txt = h("div", { class: "mu" }, "Starting...");
      const stop = h("button", { onclick: () => void chrome.runtime.sendMessage({ type: "queue-remove", id } satisfies Msg) }, "Cancel download");
      box.replaceChildren(bar, txt, stop);
      modalProgress = { itemId: id, box };
    };
    go.addEventListener("click", () => void run(true));
    add.addEventListener("click", () => void run(false));
  }

  async function commandMenu(kind: "yt" | "ff"): Promise<void> {
    const i = await deps.discover();
    const c = i.candidates.find((x) => x.kind !== "direct");
    if (!c) return toast("No manifest URL captured yet.", true);
    if (!confirm(`${TOKEN_WARNING}\n\nCopy the command to the clipboard?`)) return;
    const name = await baseName();
    const cmd = kind === "yt" ? ytDlpCommand(c.url, name) : ffmpegCommand(c.url, name);
    try {
      await navigator.clipboard.writeText(cmd);
      toast("Command copied. " + TOKEN_WARNING);
    } catch {
      prompt("Copy this command:", cmd);
    }
  }

  async function recordFallback(): Promise<void> {
    const v = document.querySelector("video");
    if (!v || typeof (v as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream !== "function") return toast("No playable <video> element found.", true);
    if (!confirm("Real-time recording takes as long as the video itself and the video must keep playing in this tab. Continue?")) return;
    const stream = (v as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream();
    const name = (await baseName()) + ".webm";
    type FsWin = Window & { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }> };
    let writer: { write(b: Blob): Promise<void>; close(): Promise<void> } | null = null;
    try {
      const fw = window as FsWin;
      if (fw.showSaveFilePicker) writer = await (await fw.showSaveFilePicker({ suggestedName: name, types: [{ accept: { "video/webm": [".webm"] } }] })).createWritable();
    } catch {
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
    let chain: Promise<void> = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      if (writer) chain = chain.then(() => writer!.write(e.data));
      else chunks.push(e.data);
    };
    const stopBtn = h("button", { class: "p" }, "Stop recording");
    const m = modal("Recording...", [h("div", { class: "mu" }, "Recording in real time. It ends when the video ends or you press stop.")], [stopBtn]);
    const finish = async () => {
      if (rec.state !== "inactive") rec.stop();
    };
    stopBtn.addEventListener("click", () => void finish());
    v.addEventListener("ended", () => void finish(), { once: true });
    rec.onstop = () => {
      void chain.then(async () => {
        m.close();
        if (writer) await writer.close();
        else {
          const a = h("a", { href: URL.createObjectURL(new Blob(chunks, { type: "video/webm" })), download: name });
          document.body.append(a);
          a.click();
          a.remove();
        }
        toast("Recording saved.");
      });
    };
    rec.start(1000);
    if (v.paused) void v.play();
  }

  async function folderDialog(): Promise<void> {
    let ref: FolderRef | null = null;
    try {
      let url = location.href;
      if (isFolderShareLink(url)) url = (await fetch(url, { credentials: "include" })).url;
      ref = folderRefFromUrl(url);
    } catch {
      /* handled below */
    }
    if (!ref) return toast("Could not resolve this folder.", true);
    const r0 = ref;
    const status = h("div", { class: "mu" }, "Loading...");
    const list = h("div", {});
    const recurse = h("input", { type: "checkbox" });
    const sort = h("select", {}, h("option", { value: "name" }, "Name"), h("option", { value: "created" }, "Created"), h("option", { value: "modified" }, "Modified"));
    let files: FolderFile[] = [];
    const checks = new Map<string, HTMLInputElement>();
    const render = () => {
      checks.clear();
      list.replaceChildren(
        ...filterAndSortVideos([...files], sort.value as SortKey).map((f) => {
          const cb = h("input", { type: "checkbox", checked: true });
          checks.set(f.ServerRelativeUrl, cb);
          return h("label", { class: "i" }, cb, f.Name);
        }),
      );
      status.textContent = `${checks.size} video file(s)`;
    };
    const rows = async (u: string): Promise<Array<Record<string, string>>> => {
      const r = await fetchWithRetry(u, { credentials: "include", headers: { Accept: "application/json;odata=nometadata" } }, { maxAttempts: 3 });
      const j = (await r.json()) as { value?: Array<Record<string, string>>; d?: { results?: Array<Record<string, string>> } };
      return j.value ?? j.d?.results ?? [];
    };
    const load = async () => {
      status.textContent = "Loading...";
      files = [];
      const walk = async (ref: FolderRef, depth: number): Promise<void> => {
        files.push(...((await rows(filesUrl(ref))) as unknown as FolderFile[]));
        if (recurse.checked && depth < 8) for (const f of await rows(foldersUrl(ref))) if (f["Name"] !== "Forms") await walk({ ...ref, serverRelativePath: f["ServerRelativeUrl"] as string }, depth + 1);
      };
      try {
        await walk(r0, 0);
        render();
      } catch (e) {
        status.textContent = `Failed: ${(e as Error).message}`;
      }
    };
    const addBtn = h("button", { class: "p" }, "Add selected to queue");
    const close = h("button", {}, "Close");
    const m = modal("Folder videos", [h("div", { class: "row" }, "Sort by", sort, h("label", { class: "i" }, recurse, "Include subfolders")), status, list], [close, addBtn]);
    close.addEventListener("click", m.close);
    sort.addEventListener("change", render);
    recurse.addEventListener("change", () => void load());
    addBtn.addEventListener("click", async () => {
      const s = await getSettings();
      const items = filterAndSortVideos([...files], sort.value as SortKey)
        .filter((f) => checks.get(f.ServerRelativeUrl)?.checked)
        .map((f) => ({ kind: "video" as const, title: f.Name.replace(/\.[^.]+$/, ""), pageUrl: streamPageUrl(r0, f.ServerRelativeUrl), site: deps.getInfo().site, mode: s.mode, quality: s.quality, needsDiscovery: true }));
      await chrome.runtime.sendMessage({ type: "enqueue-many", items } satisfies Msg);
      toast(`${items.length} file(s) added to the queue. Start the queue from the popup.`);
      m.close();
    });
    void load();
  }

  function buildWidget(): void {
    const r = ensureHost();
    if (!r) return;
    widget?.remove();
    const wrap = (label: string, items: Array<[string, () => void]>): El => {
      const menu = h("div", { class: "menu", hidden: true }, ...items.map(([t, fn]) => h("button", { onclick: () => ((menu.hidden = true), fn()) }, t)));
      const btn = h("button", { title: label, onclick: () => (menu.hidden = !menu.hidden) }, "▾");
      return h("div", { style: "position:relative" }, btn, menu);
    };
    const parts: El[] = [];
    if (info && info.candidates.length) {
      parts.push(h("div", { class: "grp" }, h("button", { class: "p", onclick: () => void quickDownload() }, "Download"), wrap("Mode and quality", [["Choose mode and quality…", () => void chooseDialog()]])));
    }
    if (info?.hasTranscriptSource) {
      const fmts: TranscriptFormat[] = ["vtt", "srt", "txt", "json"];
      parts.push(
        h("div", { class: "grp" }, h("button", { onclick: () => void downloadTranscript() }, "Transcript"), wrap("Transcript format", fmts.map((f) => [`Save as .${f}`, () => void setSettings({ transcriptFormat: f }).then(() => downloadTranscript(f))] as [string, () => void]))),
      );
    }
    if (info && info.candidates.length) {
      parts.push(h("button", { onclick: () => void enqueue({}, false).then((id) => id && toast("Added to queue")) }, "Add to queue"));
      parts.push(wrap("More", [["Copy yt-dlp command", () => void commandMenu("yt")], ["Copy ffmpeg command", () => void commandMenu("ff")]]));
    }
    if (isFolder()) parts.push(h("button", { class: "p", onclick: () => void folderDialog() }, "Folder videos…"));
    void getSettings().then((s) => {
      if (s.captureFallback && document.querySelector("video") && widget) widget.append(h("button", { onclick: () => void recordFallback() }, "Record (real-time)"));
    });
    widget = h("div", { class: "w" }, ...parts);
    if (!parts.length) widget.hidden = true;
    r.append(widget);
  }

  let sig = "";
  function addCommandBarButton(): void {
    if (!info?.hasTranscriptSource || document.getElementById("spvg-cmd")) return;
    const bar = document.querySelector('[data-automationid="CommandBar"], .ms-CommandBar, [role="menubar"]');
    if (!bar) return;
    bar.append(h("button", { id: "spvg-cmd", type: "button", style: "margin:0 4px;padding:4px 10px;cursor:pointer", onclick: () => void downloadTranscript() }, "Download transcript"));
  }
  new MutationObserver(addCommandBarButton).observe(document, { childList: true, subtree: true });

  return {
    update(i) {
      info = i;
      const s = JSON.stringify([i.candidates.map((c: Candidate) => c.kind), i.hasTranscriptSource, isFolder()]);
      if (s !== sig && (i.candidates.length || i.hasTranscriptSource || isFolder())) {
        sig = s;
        const go = () => buildWidget();
        if (document.documentElement) go();
        else document.addEventListener("DOMContentLoaded", go, { once: true });
      }
      addCommandBarButton();
    },
    progress(p) {
      if (!modalProgress || modalProgress.itemId !== p.itemId) return;
      const bar = modalProgress.box.querySelector("progress");
      const txt = modalProgress.box.querySelector(".mu");
      if (bar) (bar as HTMLProgressElement).value = p.percent;
      if (txt) txt.textContent = `${p.phase} ${p.percent.toFixed(1)}% • ${fmtBytes(p.bytes)} • ${fmtBytes(p.speed)}/s • ETA ${fmtEta(p.eta)}`;
    },
    done(m) {
      if (!modalProgress || modalProgress.itemId !== m.itemId) return;
      modalProgress.box.replaceChildren(h("div", { class: m.error ? "warn" : "" }, m.error ? `Failed: ${m.error}` : m.cancelled ? "Cancelled." : `Saved ${m.filename ?? ""}`));
      modalProgress = null;
    },
  };
}
