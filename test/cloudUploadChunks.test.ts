/**
 * services/cloud/uploadChunkCore.ts — the Content-Range arithmetic all three
 * resumable uploads share. Extracted precisely because it is the one part of a
 * chunked upload that can be tested without a live endpoint.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHUNK_SIZE,
  GRAPH_CHUNK_MULTIPLE,
  nextChunkRange,
} from "../app/main/services/cloud/uploadChunkCore";
import { uploadChunked } from "../app/main/services/cloud/transfer";

describe("nextChunkRange", () => {
  it("walks a file in whole chunks and ends with a short one", () => {
    const size = 250;
    const first = nextChunkRange(size, 0, 100)!;
    expect(first).toMatchObject({ start: 0, end: 99, length: 100 });
    expect(first.contentRange).toBe("bytes 0-99/250");

    const second = nextChunkRange(size, 100, 100)!;
    expect(second.contentRange).toBe("bytes 100-199/250");

    const last = nextChunkRange(size, 200, 100)!;
    expect(last).toMatchObject({ start: 200, end: 249, length: 50 });
    expect(last.contentRange).toBe("bytes 200-249/250");

    expect(nextChunkRange(size, 250, 100)).toBeUndefined();
  });

  it("resumes from a server-reported offset mid-chunk", () => {
    // What a provider answers after a dropped connection: "I have 0-149".
    const resumed = nextChunkRange(250, 150, 100)!;
    expect(resumed.contentRange).toBe("bytes 150-249/250");
    expect(resumed.length).toBe(100);
  });

  it("handles a file smaller than one chunk", () => {
    const only = nextChunkRange(7, 0, 100)!;
    expect(only).toMatchObject({ start: 0, end: 6, length: 7 });
    expect(only.contentRange).toBe("bytes 0-6/7");
  });

  it("returns nothing for an empty file or an out-of-range offset", () => {
    expect(nextChunkRange(0, 0, 100)).toBeUndefined();
    expect(nextChunkRange(100, 200, 100)).toBeUndefined();
    expect(nextChunkRange(100, -1, 100)).toBeUndefined();
  });

  it("rejects a non-positive chunk size instead of looping forever", () => {
    expect(() => nextChunkRange(100, 0, 0)).toThrow();
  });

  it("defaults to a Graph-legal chunk size", () => {
    // Graph requires every chunk but the last to be a multiple of 320 KiB.
    expect(DEFAULT_CHUNK_SIZE % GRAPH_CHUNK_MULTIPLE).toBe(0);
    expect(nextChunkRange(DEFAULT_CHUNK_SIZE * 3, 0)!.length).toBe(DEFAULT_CHUNK_SIZE);
  });
});

describe("uploadChunked", () => {
  it("refuses an empty file instead of looping on a chunk it cannot produce", async () => {
    // Callers route a zero-byte file through their simple-upload path, because
    // neither Drive nor Graph can finalise an empty resumable session.
    await expect(
      uploadChunked({
        localPath: "/nonexistent",
        size: 0,
        send: async () => new Response(null, { status: 200 }),
      })
    ).rejects.toThrow(/empty file/);
  });
});
