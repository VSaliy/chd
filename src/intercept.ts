/**
 * MAIN-world script (document_start, all frames). Patches fetch/XHR, reads the
 * page's own state and relays it to the isolated content script via postMessage,
 * authenticated with a per-session nonce.
 */
import { isManifestUrl } from "./lib/manifestUrl";
import { isListDataUrl } from "./lib/listSchema";
import { isTranscriptListUrl } from "./lib/transcriptApi";
import { parseTranscodeUrl } from "./lib/transcode";

(() => {
  const w = window as unknown as Record<string, unknown> & Window;
  if (w["__spvgInstalled"]) return;
  Object.defineProperty(w, "__spvgInstalled", { value: true });

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const post = (data: Record<string, unknown>) => window.postMessage({ __spvg: true, nonce, ...data }, window.location.origin);
  const announce = () => window.dispatchEvent(new CustomEvent("spvg:nonce", { detail: nonce }));

  let lastAuth = "";
  let lastSpop = "";
  const noteHeaders = (url: string, h: Record<string, string>) => {
    const auth = h["authorization"] ?? "";
    const spop = h["x-spopactoken"] ?? "";
    if ((/^bearer /i.test(auth) && auth !== lastAuth) || (spop && spop !== lastSpop)) {
      if (/^bearer /i.test(auth)) lastAuth = auth;
      if (spop) lastSpop = spop;
      post({ kind: "token", authorization: lastAuth || undefined, spopactoken: lastSpop || undefined });
    }
    if (isManifestUrl(url) || parseTranscodeUrl(url)) post({ kind: "req", url, headers: { authorization: lastAuth || undefined, spopactoken: spop || lastSpop || undefined } });
  };
  const wantBody = (url: string) => isListDataUrl(url) || isTranscriptListUrl(url);
  const sendBody = (url: string, text: string) => {
    try {
      post({ kind: "body", url, json: JSON.parse(text) });
    } catch {
      /* not JSON */
    }
  };
  const abs = (u: string) => {
    try {
      return new URL(u, location.href).toString();
    } catch {
      return u;
    }
  };

  const origFetch = w.fetch;
  w.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let url = "";
    const headers: Record<string, string> = {};
    try {
      url = abs(input instanceof Request ? input.url : String(input));
      const collect = (h?: HeadersInit) => h && new Headers(h).forEach((v, k) => (headers[k.toLowerCase()] = v));
      if (input instanceof Request) collect(input.headers);
      collect(init?.headers);
      noteHeaders(url, headers);
    } catch {
      /* never break the page */
    }
    const p = origFetch.call(this, input as RequestInfo, init);
    if (url && wantBody(url)) p.then((r) => r.clone().text().then((t) => sendBody(url, t))).catch(() => undefined);
    return p;
  } as typeof fetch;

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSet = XHR.setRequestHeader;
  const origSend = XHR.send;
  type X = XMLHttpRequest & { __spvg?: { url: string; headers: Record<string, string> } };
  XHR.open = function (this: X, method: string, url: string | URL, ...rest: unknown[]) {
    this.__spvg = { url: abs(String(url)), headers: {} };
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XHR.open;
  XHR.setRequestHeader = function (this: X, k: string, v: string) {
    if (this.__spvg) this.__spvg.headers[k.toLowerCase()] = v;
    return origSet.call(this, k, v);
  };
  XHR.send = function (this: X, body?: XMLHttpRequestBodyInit | null) {
    const s = this.__spvg;
    if (s) {
      try {
        noteHeaders(s.url, s.headers);
      } catch {
        /* ignore */
      }
      if (wantBody(s.url)) {
        this.addEventListener("load", () => {
          if (this.responseType === "" || this.responseType === "text") sendBody(s.url, this.responseText);
          else if (this.responseType === "json") post({ kind: "body", url: s.url, json: this.response });
        });
      }
    }
    return origSend.call(this, body);
  };

  const readState = () => {
    const fi = (w["g_fileInfo"] ?? {}) as Record<string, unknown>;
    const boot = (w["g_streamBootstrapContent"] ?? {}) as { dashConfig?: { cdnDecryptionKey?: unknown } };
    post({
      kind: "state",
      fileInfo: {
        displayName: fi["displayName"],
        transformUrl: fi[".transformUrl"],
        hasTranscripts: fi["hasTranscripts"],
        spItemUrl: fi[".spItemUrl"],
      },
      cdnDecryptionKey: boot.dashConfig?.cdnDecryptionKey,
      title: document.title,
    });
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data as { __spvgc?: boolean; kind?: string; nonce?: string };
    if (!d || d.__spvgc !== true) return;
    if (d.kind === "hello") announce();
    else if (d.nonce === nonce && d.kind === "read-state") readState();
  });
  window.addEventListener("spvg:req", announce);
  announce();
  document.addEventListener("DOMContentLoaded", readState);
  window.addEventListener("load", () => setTimeout(readState, 500));
})();
