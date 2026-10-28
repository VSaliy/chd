export const RETRY_STATUS = new Set([408, 409, 429]);
export const MAX_ATTEMPTS = 8;

export function shouldRetryStatus(s: number): boolean {
  return RETRY_STATUS.has(s) || (s >= 500 && s <= 599);
}

export function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const d = Date.parse(retryAfter);
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  }
  return Math.min(30000, 500 * 2 ** attempt);
}

export interface RetryDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

export async function fetchWithRetry(url: string, init: RequestInit = {}, deps: RetryDeps = {}): Promise<Response> {
  const f = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const max = deps.maxAttempts ?? MAX_ATTEMPTS;
  let last: unknown;
  for (let attempt = 0; attempt < max; attempt++) {
    if (deps.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const res = await f(url, { ...init, signal: deps.signal });
      if (res.ok) return res;
      if (!shouldRetryStatus(res.status)) throw new HttpError(res.status, url);
      last = new HttpError(res.status, url);
      if (attempt < max - 1) await sleep(backoffMs(attempt, res.headers.get("Retry-After")));
    } catch (e) {
      if (e instanceof HttpError || (e as Error).name === "AbortError") throw e;
      last = e;
      if (attempt < max - 1) await sleep(backoffMs(attempt, null));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
