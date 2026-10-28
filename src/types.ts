import type { TranscriptFormat } from "./lib/transcript";

export type Mode = "av" | "video" | "audio";
export type QualitySetting = "best" | "1080" | "720" | string; // string = representation id

export interface Settings {
  mode: Mode;
  quality: QualitySetting;
  concurrency: 1 | 2 | 4 | 8 | 16;
  template: string;
  subfolder: string;
  useFolderHandle: boolean;
  retryOnFailure: boolean;
  preferDirect: boolean;
  transcriptFormat: TranscriptFormat;
  transcriptTimestamps: boolean;
  transcriptSuffix: string;
  transcriptGroupedSuffix: string;
  captureFallback: boolean;
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
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
  debug: false,
};

export interface AuthHeaders {
  spopactoken?: string;
  authorization?: string;
}

export type CandidateKind = "manifest" | "filefallback" | "listdata" | "transcode" | "direct";

export interface Candidate {
  kind: CandidateKind;
  /** manifest URL (dash) or direct download URL */
  url: string;
  headers?: AuthHeaders;
  /** AES-128-CBC parameters as hex, for encrypted transcode delivery */
  aes?: { key: string; iv: string };
}

export interface FileInfo {
  displayName?: string;
  hasTranscripts?: boolean;
  driveId?: string;
  itemId?: string;
}

/** What one frame knows about the page. */
export interface PageInfo {
  pageUrl: string;
  origin: string;
  title: string;
  site: string;
  fileInfo: FileInfo;
  candidates: Candidate[];
  hasTranscriptSource: boolean;
}

export type ItemStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface QueueItem {
  id: string;
  kind: "video" | "transcript";
  title: string;
  pageUrl: string;
  site: string;
  mode: Mode;
  quality: QualitySetting;
  status: ItemStatus;
  /** true when stream discovery must be run by opening pageUrl in a background tab */
  needsDiscovery: boolean;
  candidates: Candidate[];
  tabId?: number;
  frameId?: number;
  error?: string;
  attempts: number;
  outputName?: string;
  addedAt: number;
}

export interface Progress {
  itemId: string;
  percent: number;
  bytes: number;
  speed: number;
  eta: number;
  phase: string;
}

export interface HistoryEntry {
  ts: number;
  filename: string;
  source: string;
}

export interface RepInfo {
  id: string;
  kind: "video" | "audio" | "text";
  label: string;
  height?: number;
  bandwidth: number;
}

/** Messages (runtime.sendMessage). */
export type Msg =
  | { type: "page-info"; info: PageInfo }
  | { type: "get-tab-state"; tabId: number }
  | { type: "enqueue"; item: Partial<QueueItem> & Pick<QueueItem, "pageUrl">; start?: boolean }
  | { type: "enqueue-many"; items: Array<Partial<QueueItem> & Pick<QueueItem, "pageUrl">> }
  | { type: "queue-get" }
  | { type: "queue-remove"; id: string }
  | { type: "queue-move"; id: string; delta: number }
  | { type: "queue-retry"; id: string }
  | { type: "queue-clear-finished" }
  | { type: "queue-start" }
  | { type: "queue-stop" }
  | { type: "inspect"; candidate: Candidate }
  | { type: "save-text"; filename: string; text: string; mime: string; source: string }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | { type: "progress"; progress: Progress }
  | { type: "job-done"; itemId: string; filename?: string; blobUrl?: string; sinkKind: "opfs" | "folder"; error?: string; cancelled?: boolean }
  | { type: "refresh"; itemId: string }
  | { type: "reread-page" }
  | { type: "discover-now" };
