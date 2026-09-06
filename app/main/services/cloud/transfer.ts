/**
 * Byte movement shared by all three providers: streaming a download to disk
 * without buffering it, and reading a chunk back for a resumable upload.
 *
 * Streaming is not an optimisation here — a post-processing `.vtu` is routinely
 * hundreds of megabytes, and buffering one in the main process would stall the
 * UI thread and risk the heap.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { renameWithRetry, tempPathFor } from "../atomicWrite";
import { CloudError } from "./cloudCore";
import { DEFAULT_CHUNK_SIZE, nextChunkRange } from "./uploadChunkCore";

/**
 * Streams a fetch response into `destPath`, landing it atomically.
 *
 * The temp suffix is `.download` rather than atomicWrite's `.<pid>.tmp` so the
 * sync engine can tell "a download in flight" from "a local write in flight" —
 * both are excluded by `isStagingArtifact`, but only one of them means the
 * document is not there yet.
 */
export async function downloadResponseTo(
  response: Response,
  destPath: string,
  total: number | undefined,
  onProgress?: (done: number, total?: number) => void
): Promise<void> {
  const body = response.body;
  if (!body) throw new CloudError("network", "The download returned an empty response.");
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.download`;
  const sink = fs.createWriteStream(tmp);
  // One listener for the whole stream: attaching it per chunk would retain
  // thousands of them on a large download and trip MaxListenersExceeded.
  let streamError: Error | undefined;
  sink.on("error", (err) => {
    streamError = err;
  });
  let done = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      if (streamError) throw streamError;
      if (value) {
        await write(sink, value);
        done += value.byteLength;
        onProgress?.(done, total);
      }
    }
    await close(sink);
    if (streamError) throw streamError;
    await fsyncFile(tmp);
    await renameWithRetry(tmp, destPath);
  } catch (err) {
    await close(sink).catch(() => undefined);
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function write(sink: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise<void>((resolve) => {
    // Respect backpressure — a fast link into a slow disk would otherwise grow
    // the stream's internal buffer without bound. Errors are surfaced by the
    // single stream-level listener in the caller, not one added per chunk.
    if (sink.write(chunk)) resolve();
    else sink.once("drain", resolve);
  });
}

function close(sink: fs.WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (sink.closed) return resolve();
    sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

/** Durable before the rename, so a crash cannot leave an empty staged file. */
async function fsyncFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readLocalSize(localPath: string): Promise<number> {
  try {
    return (await fs.promises.stat(localPath)).size;
  } catch (err) {
    throw new CloudError("notFound", `${path.basename(localPath)} is no longer on disk.`, err);
  }
}

/** `length` bytes from `offset`, for a resumable upload's next chunk. */
export async function readChunk(
  localPath: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  const handle = await fs.promises.open(localPath, "r");
  try {
    const buffer = new Uint8Array(new ArrayBuffer(length));
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The whole file as a request body. Callers must have size-checked first. */
export async function readLocalBytes(localPath: string): Promise<Uint8Array> {
  return await fs.promises.readFile(localPath);
}

/**
 * The one place bytes are handed to `fetch`.
 *
 * A `Uint8Array` backed by Node's pooled allocator is typed `ArrayBufferLike`,
 * which TypeScript's `BodyInit` (post-SharedArrayBuffer) refuses even though
 * undici accepts any ArrayBufferView at runtime. Casting once here beats either
 * a defensive copy of a 150 MB mesh or a cast at every call site.
 */
export function asBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

/** The temp path atomicWrite would use — exported so callers can recognise it. */
export { tempPathFor };

/**
 * Drives a resumable upload to completion. Shared by Google Drive and Microsoft
 * Graph, which differ only in how the session is created and how a partial
 * response reports the server's offset — the PUT-a-chunk-with-Content-Range
 * loop, the resume-after-a-dropped-chunk retry, and the "which response is the
 * final one" rule are identical.
 *
 * Retrying from the *server-reported* offset rather than our own is the point:
 * after a dropped connection the server may hold more or less than we think it
 * does, and re-sending from our own count corrupts the file.
 */
export async function uploadChunked(options: {
  localPath: string;
  size: number;
  chunkSize?: number;
  /** Sends one chunk. `contentRange` goes in the Content-Range header. */
  send: (body: Uint8Array, contentRange: string) => Promise<Response>;
  onProgress?: (done: number, total: number) => void;
  retries?: number;
}): Promise<Response> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const maxRetries = options.retries ?? 3;
  // Neither Drive nor Graph can finalise an empty resumable session, so callers
  // route a zero-byte file through their simple-upload path. Say so plainly
  // rather than spinning on a chunk that can never be produced.
  if (options.size === 0) {
    throw new CloudError("other", "An empty file cannot be sent as a resumable upload.");
  }
  let offset = 0;
  let attempts = 0;

  for (;;) {
    const chunk = nextChunkRange(options.size, offset, chunkSize);
    if (!chunk) throw new CloudError("other", "The upload ended without a final response.");
    const body = await readChunk(options.localPath, chunk.start, chunk.length);

    let response: Response;
    try {
      response = await options.send(body, chunk.contentRange);
    } catch (err) {
      if (++attempts > maxRetries) throw err;
      await delay(attempts);
      continue;
    }

    // 308 (Drive) / 202 (Graph) mean "chunk accepted, keep going".
    if (response.status === 308 || response.status === 202) {
      attempts = 0;
      offset = (await serverOffset(response)) ?? chunk.end + 1;
      options.onProgress?.(offset, options.size);
      continue;
    }
    if (response.ok) {
      options.onProgress?.(options.size, options.size);
      return response;
    }
    // A transient server-side failure is resumable; anything else is the
    // caller's to report, with the provider's own body.
    if (response.status >= 500 && ++attempts <= maxRetries) {
      await delay(attempts);
      continue;
    }
    return response;
  }
}

/** How many bytes the server says it holds, from either provider's dialect. */
async function serverOffset(response: Response): Promise<number | undefined> {
  // Drive: `Range: bytes=0-262143` — inclusive, so the next offset is end + 1.
  const range = response.headers.get("range");
  const match = range?.match(/bytes=\d+-(\d+)/);
  if (match) return Number(match[1]) + 1;
  // Graph: `{"nextExpectedRanges": ["262144-"]}`.
  try {
    const body = (await response.clone().json()) as { nextExpectedRanges?: unknown };
    const ranges = body.nextExpectedRanges;
    if (Array.isArray(ranges) && typeof ranges[0] === "string") {
      const start = Number(ranges[0].split("-")[0]);
      if (Number.isFinite(start)) return start;
    }
  } catch {
    /* not a JSON body — fall back to our own count */
  }
  return undefined;
}

function delay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
}
