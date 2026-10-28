import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isManifestUrl, normalizeManifestUrl, manifestFromTransformUrl } from "../../src/lib/manifestUrl";
import { buildManifestFromListData, isListDataUrl, sitePathOf } from "../../src/lib/listSchema";
import { parseMpd, pickVideo, pickAudio, parseIsoDuration } from "../../src/lib/mpd";
import { parseTranscript, toVtt, toSrt, toGroupedText, convertTranscript } from "../../src/lib/transcript";
import { sanitizeFilename, applyTemplate, uniqueName } from "../../src/lib/filename";
import { isFolderShareLink, folderRefFromUrl, foldersUrl, filesUrl, filterAndSortVideos, streamPageUrl } from "../../src/lib/folderUrl";
import { directUrlFromStreamPage } from "../../src/lib/directUrl";
import { fetchWithRetry, backoffMs, shouldRetryStatus } from "../../src/lib/retry";
import { ytDlpCommand, ffmpegCommand } from "../../src/lib/commands";
import { parseDecryptionKey, parseTranscodeUrl, buildTranscodeUrl } from "../../src/lib/transcode";
import { extractTemporaryDownloadUrl, isTranscriptListUrl, withJsonFormat } from "../../src/lib/transcriptApi";

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");

describe("manifest url", () => {
  it("detects manifests and ignores tempauth", () => {
    expect(isManifestUrl("https://a/transform/videomanifest?x=1")).toBe(true);
    expect(isManifestUrl("https://a/transform/videomanifest?tempauth=1")).toBe(false);
    expect(isManifestUrl("https://a/other")).toBe(false);
  });
  it("normalises", () => {
    const u = new URL(normalizeManifestUrl("https://a/t/videomanifest?part=x&format=hls&k=v"));
    expect(u.searchParams.get("part")).toBe("index");
    expect(u.searchParams.get("format")).toBe("dash");
    expect(u.searchParams.get("k")).toBe("v");
  });
  it("builds from transformUrl", () => {
    const u = manifestFromTransformUrl("https://a/_api/v2.1/drives/d/items/i/transform/thumbnail?x=1")!;
    expect(u).toContain("/transform/videomanifest");
    expect(u).toContain("part=index&format=dash");
    expect(manifestFromTransformUrl("https://a/nothing")).toBeNull();
  });
});

describe("list schema", () => {
  it("fills template", () => {
    const u = new URL(buildManifestFromListData(JSON.parse(fx("renderlistdata.json")))!);
    expect(u.pathname).toMatch(/\/transform\/videomanifest$/);
    expect(u.searchParams.get("inputFormat")).toBe("mp4");
    expect(u.searchParams.get("cs")).toBe("SPO.Web");
    expect(u.searchParams.get("access_token")).toBe("TOKEN123");
    expect(u.searchParams.get("docid")).toContain("ITEM123");
    expect(u.searchParams.get("format")).toBe("dash");
    expect(u.searchParams.get("part")).toBe("Index");
    expect(u.searchParams.get("action")).toBe("Access");
    expect(u.searchParams.get("useScf")).toBe("True");
    expect(u.searchParams.get("pretranscode")).toBe("0");
    expect(u.searchParams.get("transcodeahead")).toBe("0");
  });
  it("returns null without template", () => {
    expect(buildManifestFromListData({ ListSchema: {} })).toBeNull();
  });
  it("matches list data urls and site paths", () => {
    expect(isListDataUrl("https://a/_api/web/GetList(@a1)/RenderListDataAsStream?@a1=%27x%27")).toBe(true);
    expect(sitePathOf("/sites/foo/bar")).toBe("/sites/foo");
    expect(sitePathOf("/x")).toBe("");
  });
});

describe("mpd", () => {
  const mpd = parseMpd(fx("sample.mpd"), "https://host/p/videomanifest?part=index&format=dash");
  it("lists representations", () => {
    expect(mpd.duration).toBe(10);
    expect(mpd.representations.map((r) => r.id)).toEqual(["v1080", "v720", "v360", "a1"]);
    expect(mpd.representations[0]).toMatchObject({ kind: "video", height: 1080, bandwidth: 4000000, codecs: "avc1.640028" });
  });
  it("expands timeline templates with entity-decoded query", () => {
    const r = mpd.representations[0]!;
    expect(r.initUrl).toBe("https://host/p/video_v1080_init.mp4?tempToken=abc&x=1");
    expect(r.segments.map((s) => s.url.split("_").pop()!.split(".")[0])).toEqual(["0", "4000", "8000"]);
    expect(r.segments.map((s) => s.duration)).toEqual([4, 4, 2]);
  });
  it("expands number templates", () => {
    const a = mpd.representations[3]!;
    expect(a.segments).toHaveLength(2);
    expect(a.segments[0]!.url).toBe("https://host/p/audio_00001.m4s");
    expect(a.lang).toBe("en");
  });
  it("picks quality", () => {
    expect(pickVideo(mpd.representations, "best")!.id).toBe("v1080");
    expect(pickVideo(mpd.representations, "720")!.id).toBe("v720");
    expect(pickVideo(mpd.representations, { id: "v360" })!.id).toBe("v360");
    expect(pickAudio(mpd.representations)!.id).toBe("a1");
  });
  it("parses durations", () => {
    expect(parseIsoDuration("PT1H2M3.5S")).toBe(3723.5);
  });
});

describe("transcript", () => {
  const json = JSON.parse(fx("transcript.json"));
  it("parses and drops empty", () => {
    const c = parseTranscript(json);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ start: 1.23, end: 3.5, speaker: "Alice Example" });
  });
  it("vtt has voice tags and escapes", () => {
    const v = toVtt(parseTranscript(json));
    expect(v.startsWith("WEBVTT")).toBe(true);
    expect(v).toContain("00:00:01.230 --> 00:00:03.500\n<v Alice Example>Hello everyone.");
    expect(v).toContain("&lt;demo&gt;");
  });
  it("srt", () => {
    expect(toSrt(parseTranscript(json))).toContain("1\n00:00:01,230 --> 00:00:03,500\nAlice Example: Hello everyone.");
  });
  it("grouped", () => {
    const g = toGroupedText(parseTranscript(json), true);
    expect(g).toBe("[00:00:01] Alice Example:\nHello everyone. Welcome to the <demo>.\n\n[00:01:05] Bob Sample:\nThanks, glad to be here.\n");
    expect(toGroupedText(parseTranscript(json), false)).not.toContain("[");
  });
  it("json passthrough", () => {
    expect(JSON.parse(convertTranscript(json, "json"))).toEqual(json);
  });
  it("urls", () => {
    expect(isTranscriptListUrl("https://a/media/transcripts?x")).toBe(true);
    expect(isTranscriptListUrl("https://a/media/transcripts/1/content")).toBe(false);
    expect(extractTemporaryDownloadUrl({ value: [{ temporaryDownloadUrl: "https://t/x" }] })).toBe("https://t/x");
    expect(withJsonFormat("https://t/x?a=1")).toBe("https://t/x?a=1&format=json");
  });
});

describe("filename", () => {
  it("sanitises", () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j\u0001k. ')).toBe("abcdefghijk");
    expect(sanitizeFilename("CON")).toBe("_CON");
    expect(sanitizeFilename("nul.txt")).toBe("_nul.txt");
    expect(sanitizeFilename("x".repeat(300))).toHaveLength(150);
    expect(sanitizeFilename("  ", "42")).toBe("video_42");
  });
  it("applies template", () => {
    const now = new Date(2024, 0, 5, 3, 4, 5);
    expect(applyTemplate("{title}_{date}_{time}_{site}_{quality}_{id}", { title: "T", site: "s", quality: "720p", id: "9", now })).toBe("T_2024-01-05_03-04-05_s_720p_9");
    expect(applyTemplate("{title}", { title: "", id: "7" })).toBe("video_7");
  });
  it("uniquifies", () => {
    expect(uniqueName("a", ".mp4", ["a.mp4", "A_1.mp4"])).toBe("a_2.mp4");
    expect(uniqueName("b", ".mp4", [])).toBe("b.mp4");
  });
});

describe("folders", () => {
  it("detects share links", () => {
    expect(isFolderShareLink("https://c-my.sharepoint.com/:f:/g/personal/u/EAbC123?e=x")).toBe(true);
    expect(isFolderShareLink("https://c-my.sharepoint.com/:v:/g/personal/u/EAbC123")).toBe(false);
  });
  it("builds REST urls", () => {
    const ref = folderRefFromUrl("https://c.sharepoint.com/sites/team/_layouts/15/onedrive.aspx?id=%2Fsites%2Fteam%2FShared%20Documents%2FIt's")!;
    expect(ref.sitePath).toBe("/sites/team");
    expect(foldersUrl(ref)).toContain("GetFolderByServerRelativeUrl('" + encodeURIComponent("/sites/team/Shared Documents/It''s") + "')/Folders");
    expect(filesUrl(ref)).toContain("/Files?");
    expect(streamPageUrl(ref, "/sites/team/a b.mp4")).toBe("https://c.sharepoint.com/sites/team/_layouts/15/stream.aspx?id=%2Fsites%2Fteam%2Fa%20b.mp4");
  });
  it("filters and sorts", () => {
    const f = [
      { Name: "b.mp4", ServerRelativeUrl: "", TimeCreated: "2024-01-02T00:00:00Z" },
      { Name: "a.mp4", ServerRelativeUrl: "", TimeCreated: "2024-01-03T00:00:00Z" },
      { Name: "doc.docx", ServerRelativeUrl: "" },
    ];
    expect(filterAndSortVideos([...f], "name").map((x) => x.Name)).toEqual(["a.mp4", "b.mp4"]);
    expect(filterAndSortVideos([...f], "created").map((x) => x.Name)).toEqual(["b.mp4", "a.mp4"]);
  });
});

describe("direct url", () => {
  it("rebuilds path", () => {
    expect(directUrlFromStreamPage("https://c-my.sharepoint.com/personal/u/_layouts/15/stream.aspx?id=%2Fpersonal%2Fu%2FDocuments%2FMy+Rec%23%201.mp4&referrer=x")).toBe(
      "https://c-my.sharepoint.com/personal/u/Documents/My%20Rec%23%201.mp4?download=1".replace("/personal/u/Documents", "/personal/u/Documents"),
    );
    expect(directUrlFromStreamPage("https://a/stream.aspx")).toBeNull();
  });
});

describe("retry", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  it("classifies", () => {
    for (const s of [408, 409, 429, 500, 503]) expect(shouldRetryStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404]) expect(shouldRetryStatus(s)).toBe(false);
  });
  it("honours Retry-After and succeeds", async () => {
    sleeps.length = 0;
    let n = 0;
    const f = (async () => (n++ < 2 ? new Response("", { status: 429, headers: { "Retry-After": "3" } }) : new Response("ok"))) as typeof fetch;
    const r = await fetchWithRetry("https://x", {}, { fetchFn: f, sleep });
    expect(await r.text()).toBe("ok");
    expect(sleeps).toEqual([3000, 3000]);
  });
  it("retries network errors, gives up after 8", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      throw new TypeError("net");
    }) as typeof fetch;
    await expect(fetchWithRetry("https://x", {}, { fetchFn: f, sleep })).rejects.toThrow("net");
    expect(n).toBe(8);
  });
  it("does not retry 404", async () => {
    let n = 0;
    const f = (async () => (n++, new Response("", { status: 404 }))) as typeof fetch;
    await expect(fetchWithRetry("https://x", {}, { fetchFn: f, sleep })).rejects.toThrow("HTTP 404");
    expect(n).toBe(1);
  });
  it("backoff grows", () => {
    expect(backoffMs(0, null)).toBeLessThan(backoffMs(3, null));
  });
});

describe("commands", () => {
  it("builds", () => {
    expect(ytDlpCommand("https://m/x?a=1", "n")).toBe('yt-dlp --no-part -N 4 -o "n.mp4" "https://m/x?a=1"');
    expect(ffmpegCommand("https://m/x", "n")).toBe('ffmpeg -i "https://m/x" -c copy "n.mp4"');
  });
});

describe("transcode", () => {
  it("parses url and builds parts", () => {
    const s = "https://t.sharepoint.com/sites/x/_api_cached/v2.1/drives/D/items/I/oneDrive.transcode?part=initsegment&track=video&wsd=1&ppd=2&ppst=3";
    expect(parseTranscodeUrl(s)).toMatchObject({ driveId: "D", itemId: "I" });
    const u = new URL(buildTranscodeUrl(s, "mediasegment", "audio", { n: "4" }));
    expect(u.searchParams.get("part")).toBe("mediasegment");
    expect(u.searchParams.get("track")).toBe("audio");
    expect(u.searchParams.get("wsd")).toBe("1");
    expect(u.searchParams.get("n")).toBe("4");
  });
  it("parses keys", () => {
    const k = "00112233445566778899aabbccddeeff";
    const p = parseDecryptionKey({ key: k, iv: "ffeeddccbbaa99887766554433221100" })!;
    expect(p.key[1]).toBe(0x11);
    expect(p.iv[0]).toBe(0xff);
    expect(parseDecryptionKey(`${k}:${k}`)!.iv).toHaveLength(16);
    expect(parseDecryptionKey("zz")).toBeNull();
  });
});

import { isAllowedUrl, sanitizeSubfolder } from "../../src/lib/hosts";
describe("hosts", () => {
  it("allows only tenant hosts over https", () => {
    expect(isAllowedUrl("https://contoso-my.sharepoint.com/x")).toBe(true);
    expect(isAllowedUrl("https://contoso.sharepoint.com.mcas.ms/x")).toBe(true);
    expect(isAllowedUrl("https://teams.microsoft.com/x")).toBe(true);
    expect(isAllowedUrl("https://evil.com/sharepoint.com")).toBe(false);
    expect(isAllowedUrl("https://sharepoint.com.evil.com/")).toBe(false);
    expect(isAllowedUrl("http://a.sharepoint.com/")).toBe(false);
  });
  it("sanitises subfolders", () => {
    expect(sanitizeSubfolder("../a/<b>/c.")).toBe("a/b/c");
    expect(sanitizeSubfolder("")).toBe("");
  });
});
