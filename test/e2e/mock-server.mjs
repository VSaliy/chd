// Local mock "SharePoint": fake stream.aspx, DASH MPD + fMP4 segments, transcripts, direct file.
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function startMock({ dir, cert, key }) {
  const state = {
    directAllowed: false,
    expireAfter: Infinity, // invalidate the first token after this many segment requests
    tokens: 0,
    validToken: null,
    segRequests: 0,
    manifestHits: 0,
    log: [],
  };
  const DRV = "DRV1";
  const ITM = "ITM1";
  const base = `/personal/user/_api/v2.1/drives/${DRV}/items/${ITM}`;
  const transcript = readFileSync(new URL("../fixtures/transcript.json", import.meta.url), "utf8");
  const mpdSrc = readFileSync(join(dir, "dash", "manifest.mpd"), "utf8");

  const server = https.createServer({ cert, key }, (req, res) => {
    const u = new URL(req.url, "https://test-my.sharepoint.com");
    state.log.push(`${req.method} ${u.pathname}${u.search}`);
    const send = (code, body, type = "text/plain", extra = {}) => {
      res.writeHead(code, { "Content-Type": type, ...extra });
      res.end(body);
    };
    if (u.pathname.endsWith("/stream.aspx")) {
      const token = `T${++state.tokens}`;
      state.validToken ??= token;
      const manifest = `${base}/transform/videomanifest?provider=spo&part=index&format=dash&tempToken=${token}`;
      return send(
        200,
        `<!doctype html><title>Mock Meeting - Stream</title><body><h1>Mock stream page</h1><script>
window.g_fileInfo = { displayName: "Mock Meeting", ".transformUrl": "${base}/transform/thumbnail?x=1", hasTranscripts: true };
window.addEventListener("load", () => {
  fetch(${JSON.stringify(manifest)}, { headers: { Authorization: "Bearer mock-token" } });
  fetch(${JSON.stringify(`${base}/media/transcripts`)});
});
</script></body>`,
        "text/html",
      );
    }
    if (u.pathname === `${base}/transform/videomanifest`) {
      state.manifestHits++;
      const tok = u.searchParams.get("tempToken");
      const out = mpdSrc
        .replace(/(initialization|media)="([^"]*)"/g, (_m, k, v) => `${k}="seg/${v}?tempToken=${tok}"`);
      return send(200, out, "application/dash+xml");
    }
    if (u.pathname.startsWith(`${base}/transform/seg/`)) {
      const tok = u.searchParams.get("tempToken");
      const isMedia = !u.pathname.includes("/init-");
      if (isMedia) {
        state.segRequests++;
        if (tok === state.validToken && state.segRequests > state.expireAfter) state.validToken = "expired";
      }
      if (tok !== state.validToken && tok === "T1" && state.validToken === "expired") return send(403, "token expired");
      const f = join(dir, "dash", u.pathname.split("/").pop());
      if (!existsSync(f)) return send(404, "nf");
      return send(200, readFileSync(f), "video/mp4");
    }
    if (u.pathname === `${base}/media/transcripts`) {
      return send(200, JSON.stringify({ value: [{ temporaryDownloadUrl: `https://test-my.sharepoint.com/personal/user/transcript-dl?id=1` }] }), "application/json");
    }
    if (u.pathname.endsWith("/transcript-dl")) {
      return send(200, transcript, "application/json");
    }
    if (u.pathname.endsWith("/Documents/Mock Meeting.mp4") || u.pathname.endsWith("/Documents/Mock%20Meeting.mp4")) {
      if (!state.directAllowed) return send(403, "no download rights");
      const data = readFileSync(join(dir, "source.mp4"));
      const range = req.headers.range;
      if (range) return send(206, data.subarray(0, 1), "video/mp4", { "Content-Range": `bytes 0-0/${data.length}` });
      return send(200, data, "video/mp4", { "Content-Length": data.length });
    }
    send(404, "not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}
