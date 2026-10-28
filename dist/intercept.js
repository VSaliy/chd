"use strict";
(() => {
  // src/lib/manifestUrl.ts
  function isManifestUrl(url) {
    return url.includes("videomanifest") && !url.includes("tempauth");
  }

  // src/lib/listSchema.ts
  var LIST_DATA_URL_MARKERS = [
    "RenderListDataAsStream?@a1=",
    "RenderListDataAsStream?@listUrl",
    "SP.List.GetListDataAsStream?listFullUrl"
  ];
  function isListDataUrl(url) {
    return LIST_DATA_URL_MARKERS.some((m) => url.includes(m));
  }

  // src/lib/transcriptApi.ts
  function isTranscriptListUrl(url) {
    return url.includes("transcripts") && !url.includes("/content") && !url.includes("/cdnmedia/");
  }

  // src/lib/transcode.ts
  var RE = /\/_api_cached\/v2\.1\/drives\/([^/]+)\/items\/([^/]+)\/oneDrive\.transcode/i;
  function parseTranscodeUrl(url) {
    try {
      const u = new URL(url);
      const m = RE.exec(u.pathname);
      if (!m) return null;
      return { driveId: m[1], itemId: m[2], url: u };
    } catch {
      return null;
    }
  }

  // src/intercept.ts
  (() => {
    const w = window;
    if (w["__spvgInstalled"]) return;
    Object.defineProperty(w, "__spvgInstalled", { value: true });
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const post = (data) => window.postMessage({ __spvg: true, nonce, ...data }, window.location.origin);
    const announce = () => window.dispatchEvent(new CustomEvent("spvg:nonce", { detail: nonce }));
    let lastAuth = "";
    let lastSpop = "";
    const noteHeaders = (url, h) => {
      const auth = h["authorization"] ?? "";
      const spop = h["x-spopactoken"] ?? "";
      if (/^bearer /i.test(auth) && auth !== lastAuth || spop && spop !== lastSpop) {
        if (/^bearer /i.test(auth)) lastAuth = auth;
        if (spop) lastSpop = spop;
        post({ kind: "token", authorization: lastAuth || void 0, spopactoken: lastSpop || void 0 });
      }
      if (isManifestUrl(url) || parseTranscodeUrl(url)) post({ kind: "req", url, headers: { authorization: lastAuth || void 0, spopactoken: spop || lastSpop || void 0 } });
    };
    const wantBody = (url) => isListDataUrl(url) || isTranscriptListUrl(url);
    const sendBody = (url, text) => {
      try {
        post({ kind: "body", url, json: JSON.parse(text) });
      } catch {
      }
    };
    const abs = (u) => {
      try {
        return new URL(u, location.href).toString();
      } catch {
        return u;
      }
    };
    const origFetch = w.fetch;
    w.fetch = function(input, init) {
      let url = "";
      const headers = {};
      try {
        url = abs(input instanceof Request ? input.url : String(input));
        const collect = (h) => h && new Headers(h).forEach((v, k) => headers[k.toLowerCase()] = v);
        if (input instanceof Request) collect(input.headers);
        collect(init?.headers);
        noteHeaders(url, headers);
      } catch {
      }
      const p = origFetch.call(this, input, init);
      if (url && wantBody(url)) p.then((r) => r.clone().text().then((t) => sendBody(url, t))).catch(() => void 0);
      return p;
    };
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSet = XHR.setRequestHeader;
    const origSend = XHR.send;
    XHR.open = function(method, url, ...rest) {
      this.__spvg = { url: abs(String(url)), headers: {} };
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.setRequestHeader = function(k, v) {
      if (this.__spvg) this.__spvg.headers[k.toLowerCase()] = v;
      return origSet.call(this, k, v);
    };
    XHR.send = function(body) {
      const s = this.__spvg;
      if (s) {
        try {
          noteHeaders(s.url, s.headers);
        } catch {
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
      const fi = w["g_fileInfo"] ?? {};
      const boot = w["g_streamBootstrapContent"] ?? {};
      post({
        kind: "state",
        fileInfo: {
          displayName: fi["displayName"],
          transformUrl: fi[".transformUrl"],
          hasTranscripts: fi["hasTranscripts"],
          spItemUrl: fi[".spItemUrl"]
        },
        cdnDecryptionKey: boot.dashConfig?.cdnDecryptionKey,
        title: document.title
      });
    };
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__spvgc !== true) return;
      if (d.kind === "hello") announce();
      else if (d.nonce === nonce && d.kind === "read-state") readState();
    });
    window.addEventListener("spvg:req", announce);
    announce();
    document.addEventListener("DOMContentLoaded", readState);
    window.addEventListener("load", () => setTimeout(readState, 500));
  })();
})();
