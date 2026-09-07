/**
 * Content-Range arithmetic for resumable uploads. Pure, and shared by all three
 * providers because they only differ in the URL and the response shape:
 * Drive's `uploadType=resumable`, Graph's `createUploadSession` (mandatory
 * above 4 MB, i.e. for essentially every real CAD/mesh file), and Dropbox's
 * `upload_session/append_v2` (above 150 MB).
 */

export interface ChunkRange {
  start: number;
  /** Inclusive, as the Content-Range header wants it. */
  end: number;
  length: number;
  /** `bytes <start>-<end>/<size>` */
  contentRange: string;
}

/** Graph requires every chunk but the last to be a multiple of 320 KiB. */
export const GRAPH_CHUNK_MULTIPLE = 320 * 1024;
export const DEFAULT_CHUNK_SIZE = GRAPH_CHUNK_MULTIPLE * 10; // 3.2 MiB

/** The next chunk to send, or undefined when the whole file is uploaded. */
export function nextChunkRange(
  size: number,
  offset: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): ChunkRange | undefined {
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");
  if (offset < 0 || offset >= size) return undefined;
  const length = Math.min(chunkSize, size - offset);
  const end = offset + length - 1;
  return { start: offset, end, length, contentRange: `bytes ${offset}-${end}/${size}` };
}
