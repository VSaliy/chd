/** Output sinks: OPFS (then chrome.downloads) or a user-picked directory (File System Access API). */
import { uniqueName } from "../lib/filename";
import { idbGet } from "../shared/idb";

export interface Sink {
  kind: "opfs" | "folder";
  /** final file name (folder sink) or OPFS file name */
  name: string;
  write(b: Uint8Array): Promise<void>;
  patch(offset: number, b: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  abort(): Promise<void>;
}

type SyncHandle = { write(b: Uint8Array, o: { at: number }): number; flush(): void; close(): void };
type FileHandleSync = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };
type Perm = FileSystemDirectoryHandle & { queryPermission(d: { mode: string }): Promise<string>; entries(): AsyncIterable<[string, unknown]> };

export async function openOpfsSink(fileName: string): Promise<Sink> {
  const root = await navigator.storage.getDirectory();
  const fh = (await root.getFileHandle(fileName, { create: true })) as FileHandleSync;
  const h = await fh.createSyncAccessHandle();
  let pos = 0;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      try {
        h.flush();
        h.close();
      } catch {
        /* already closed */
      }
    }
  };
  return {
    kind: "opfs",
    name: fileName,
    async write(b) {
      h.write(b, { at: pos });
      pos += b.length;
    },
    async patch(offset, b) {
      h.write(b, { at: offset });
    },
    async finish() {
      close();
    },
    async abort() {
      close();
      await root.removeEntry(fileName).catch(() => undefined);
    },
  };
}

export async function removeOpfsFile(fileName: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(fileName).catch(() => undefined);
}

/** Returns the stored output directory if the user granted permission, else null. */
export async function getOutputDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const dir = await idbGet<Perm>("outputDir");
    if (dir && (await dir.queryPermission({ mode: "readwrite" })) === "granted") return dir;
  } catch {
    /* fall through */
  }
  return null;
}

export async function openFolderSink(dir: FileSystemDirectoryHandle, base: string, ext: string): Promise<Sink> {
  const names: string[] = [];
  for await (const [n] of (dir as Perm).entries()) names.push(n);
  const name = uniqueName(base, ext, names);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  let pos = 0;
  return {
    kind: "folder",
    name,
    async write(b) {
      await w.write({ type: "write", position: pos, data: b as BufferSource });
      pos += b.length;
    },
    async patch(offset, b) {
      await w.write({ type: "write", position: offset, data: b as BufferSource });
    },
    async finish() {
      await w.close();
    },
    async abort() {
      await w.abort().catch(() => undefined);
      await dir.removeEntry(name).catch(() => undefined);
    },
  };
}
