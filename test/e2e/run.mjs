// End-to-end test: loads dist/ as an unpacked extension in Chromium against a local mock SharePoint.
import { chromium } from "playwright";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { startMock } from "./mock-server.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const dist = join(root, "dist");
const work = mkdtempSync(join(tmpdir(), "spvg-e2e-"));
const EXPECTED_DURATION = 6;

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
}

// 1. Short test clip -> DASH fMP4 + progressive source
mkdirSync(join(work, "dash"));
const inputs = ["-f", "lavfi", "-i", `testsrc=size=320x240:rate=25:duration=${EXPECTED_DURATION}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${EXPECTED_DURATION}`];
// VP9 + Opus: Playwright's Chromium has no proprietary H.264/AAC decoders, but plays these in MP4.
const enc = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p", "-g", "50", "-keyint_min", "50", "-c:a", "libopus", "-strict", "-2", "-t", String(EXPECTED_DURATION)];
sh("ffmpeg", ["-y", ...inputs, ...enc, "-movflags", "+faststart", join(work, "source.mp4")]);
sh("ffmpeg", ["-y", ...inputs, ...enc, "-f", "dash", "-dash_segment_type", "mp4", "-seg_duration", "2", "-use_template", "1", "-use_timeline", "1", "-adaptation_sets", "id=0,streams=v id=1,streams=a",
  "-init_seg_name", "init-$RepresentationID$.m4s", "-media_seg_name", "chunk-$RepresentationID$-$Number%05d$.m4s", join(work, "dash", "manifest.mpd")]);

// 2. TLS cert for *.sharepoint.com (mapped to the mock via --host-resolver-rules)
sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "k.pem"), "-out", join(work, "c.pem"), "-subj", "/CN=test-my.sharepoint.com", "-days", "2"]);
const { server, state, port } = await startMock({ dir: work, cert: readFileSync(join(work, "c.pem")), key: readFileSync(join(work, "k.pem")) });

// 3. Browser profile with a fixed download directory
const profile = join(work, "profile");
const downloads = join(work, "downloads");
mkdirSync(join(profile, "Default"), { recursive: true });
mkdirSync(downloads);
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads } }));

const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--host-resolver-rules=MAP *.sharepoint.com 127.0.0.1:${port}`, "--ignore-certificate-errors", "--remote-debugging-port=9333"],
});

// Playwright redirects downloads to its artifacts dir; point the browser back at our folder over raw CDP.
{
  const v = await (await fetch("http://127.0.0.1:9333/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const done = new Promise((r) => (ws.onmessage = r));
  ws.send(JSON.stringify({ id: 1, method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: downloads } }));
  await done;
  ws.close();
}

let failed = false;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL - ${name}\n${e.stack}`);
  }
}

const files = () => readdirSync(downloads).filter((f) => !f.endsWith(".crdownload") && !f.startsWith("."));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  const sw = ctx.serviceWorkers()[0];
  const dl = sw ? await sw.evaluate(() => chrome.downloads.search({}).then((r) => r.map((d) => [d.filename, d.state, d.error]))) : [];
  throw new Error(`timeout waiting for ${what}. downloads=${JSON.stringify(dl)}. mock log:\n${state.log.slice(-25).join("\n")}`);
}

async function checkPlayable(file, label) {
  const p = await ctx.newPage();
  await p.goto("file://" + join(downloads, file));
  const info = await p.evaluate(async () => {
    const v = document.querySelector("video");
    v.muted = true;
    await new Promise((res, rej) => {
      if (v.readyState >= 1) return res();
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error("video error " + v.error?.message));
      setTimeout(() => rej(new Error("metadata timeout")), 10000);
    });
    await v.play();
    await new Promise((r) => setTimeout(r, 800));
    return { duration: v.duration, w: v.videoWidth, h: v.videoHeight, t: v.currentTime };
  });
  await p.close();
  assert.ok(Math.abs(info.duration - EXPECTED_DURATION) < 0.35, `${label}: duration ${info.duration} vs ${EXPECTED_DURATION}`);
  assert.equal(info.w, 320);
  assert.ok(info.t > 0, `${label}: playback did not advance`);
}

const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
const url = "https://test-my.sharepoint.com/personal/user/_layouts/15/stream.aspx?id=%2Fpersonal%2Fuser%2FDocuments%2FMock+Meeting.mp4";

await step("muxed DASH download (with token expiry and re-capture)", async () => {
  state.expireAfter = 2;
  await page.goto(url);
  await page.getByRole("button", { name: "Download", exact: true }).click({ timeout: 20000 });
  await waitFor(() => files().some((f) => f.endsWith(".mp4")), 90000, "muxed mp4");
  const f = files().find((x) => x.endsWith(".mp4"));
  assert.equal(f, "Mock Meeting.mp4");
  assert.ok(state.manifestHits >= 2, "expected a re-captured manifest after token expiry, hits=" + state.manifestHits);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", join(downloads, f)]).toString());
  assert.deepEqual(probe.streams.map((x) => x.codec_type).sort(), ["audio", "video"]);
  assert.ok(Math.abs(Number(probe.format.duration) - EXPECTED_DURATION) < 0.35, "ffprobe duration " + probe.format.duration);
  await checkPlayable(f, "muxed");
});

await step("transcript download as VTT", async () => {
  await page.getByRole("button", { name: "Transcript", exact: true }).click({ timeout: 20000 });
  const f = await waitFor(() => files().find((x) => x.endsWith(".vtt")), 20000, "vtt");
  assert.equal(f, "Mock Meeting_transcript.vtt");
  const t = readFileSync(join(downloads, f), "utf8");
  assert.ok(t.startsWith("WEBVTT"));
  assert.ok(t.includes("<v Alice Example>Hello everyone."));
});

await step("direct file download is preferred when allowed; names are uniquified", async () => {
  state.directAllowed = true;
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await p2.getByRole("button", { name: "Download", exact: true }).click({ timeout: 20000 });
  const f = await waitFor(() => files().find((x) => /^Mock Meeting_1\.mp4$/.test(x)), 30000, "direct mp4");
  await checkPlayable(f, "direct");
  await p2.close();
});

await step("queue is persisted in storage and finished", async () => {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const q = await sw.evaluate(() => chrome.storage.local.get("queue"));
  assert.ok(q.queue.length >= 2);
  assert.ok(q.queue.every((i) => i.status === "done"), JSON.stringify(q.queue.map((i) => [i.status, i.error])));
});

await ctx.close();
server.close();
rmSync(work, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("e2e passed");
