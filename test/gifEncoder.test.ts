/**
 * tools/lib/gif.mjs — the dependency-free GIF89a encoder behind the docs
 * animations. The decoder below is independent of the encoder (written from the
 * spec), so the round trip proves the LZW stream rather than mirroring it.
 */
import { describe, expect, it } from "vitest";
import { encodeGif, type GifFrame } from "../tools/lib/gif.mjs";

interface Decoded {
  width: number;
  height: number;
  loop: number | undefined;
  palette: number[][];
  frames: { delay: number; indices: Uint8Array }[];
}

function decodeLzw(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let size = minCodeSize + 1, bitBuf = 0, bitCount = 0, pos = 0;
  const read = () => {
    while (bitCount < size) { bitBuf |= data[pos++] << bitCount; bitCount += 8; }
    const code = bitBuf & ((1 << size) - 1);
    bitBuf >>>= size; bitCount -= size;
    return code;
  };
  let table: number[][] = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push([], []);
    size = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let prev: number[] | undefined;
  while (out.length < pixels) {
    const code = read();
    if (code === clear) { reset(); prev = undefined; continue; }
    if (code === eoi) break;
    let entry: number[];
    if (code < table.length) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error("bad code");
    out.push(...entry);
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    if (table.length === 1 << size && size < 12) size++;
  }
  return Uint8Array.from(out);
}

function decode(buf: Uint8Array): Decoded {
  expect(Buffer.from(buf.slice(0, 6)).toString()).toBe("GIF89a");
  let p = 6;
  const u16 = () => { const v = buf[p] | (buf[p + 1] << 8); p += 2; return v; };
  const width = u16(), height = u16();
  const flags = buf[p]; p += 3;
  const palette: number[][] = [];
  const n = 1 << ((flags & 7) + 1);
  for (let i = 0; i < n; i++) { palette.push([buf[p], buf[p + 1], buf[p + 2]]); p += 3; }
  const out: Decoded = { width, height, loop: undefined, palette, frames: [] };
  let delay = 0;
  for (;;) {
    const b = buf[p++];
    if (b === 0x3b) return out;
    if (b === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) { p++; p++; delay = buf[p] | (buf[p + 1] << 8); p += 3; p++; }
      else if (label === 0xff) {
        p += 12; p++; p++; out.loop = buf[p] | (buf[p + 1] << 8); p += 2; p++;
      } else throw new Error("unexpected extension");
    } else if (b === 0x2c) {
      p += 8; p++;
      const min = buf[p++];
      const bytes: number[] = [];
      for (let len = buf[p++]; len; len = buf[p++]) { for (let i = 0; i < len; i++) bytes.push(buf[p + i]); p += len; }
      out.frames.push({ delay, indices: decodeLzw(Uint8Array.from(bytes), min, width * height) });
    } else throw new Error(`unexpected block 0x${b.toString(16)}`);
  }
}

const frame = (w: number, h: number, fn: (x: number, y: number) => [number, number, number]): GifFrame => {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y), i = (y * w + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  return { width: w, height: h, rgba };
};

describe("encodeGif", () => {
  it("writes the header, size, loop extension, delays and one image per frame", () => {
    const a = frame(8, 4, () => [10, 20, 30]);
    const g = decode(encodeGif([a, a, a], { delayMs: 100 }));
    expect([g.width, g.height]).toEqual([8, 4]);
    expect(g.loop).toBe(0);
    expect(g.frames).toHaveLength(3);
    expect(g.frames.map((f) => f.delay)).toEqual([10, 10, 10]);
    expect(g.palette).toHaveLength(256);
  });

  it("round-trips flat colours through the palette and LZW stream", () => {
    const f = frame(16, 16, (x) => (x < 8 ? [248, 0, 0] : [0, 0, 248]));
    const g = decode(encodeGif([f]));
    for (let i = 0; i < 256; i++) {
      const c = g.palette[g.frames[0].indices[i]];
      const want = i % 16 < 8 ? [248, 0, 0] : [0, 0, 248];
      c.forEach((v, k) => expect(Math.abs(v - want[k])).toBeLessThanOrEqual(8));
    }
  });

  it("survives a dictionary overflow (noisy frame, >4096 codes, clear mid-stream)", () => {
    let s = 12345;
    const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const f = frame(128, 96, () => [rnd() * 255, rnd() * 255, rnd() * 255].map(Math.floor) as [number, number, number]);
    const g = decode(encodeGif([f]));
    expect(g.frames[0].indices).toHaveLength(128 * 96);
    let worst = 0;
    for (let i = 0; i < 128 * 96; i++) {
      const c = g.palette[g.frames[0].indices[i]];
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(c[k] - f.rgba[i * 4 + k]));
    }
    expect(worst).toBeLessThan(128); // 256 colours for ~12k random pixels: coarse but bounded
  });

  it("keeps different frames different and uses a shared palette", () => {
    const a = frame(8, 8, (x) => [x * 30, 0, 0]);
    const b = frame(8, 8, (x) => [0, x * 30, 0]);
    const g = decode(encodeGif([a, b]));
    expect(Array.from(g.frames[0].indices)).not.toEqual(Array.from(g.frames[1].indices));
  });

  it("is deterministic", () => {
    const a = frame(32, 32, (x, y) => [x * 7, y * 7, (x + y) * 3]);
    const b = frame(32, 32, (x, y) => [y * 7, x * 7, (x * y) & 255]);
    expect(Buffer.from(encodeGif([a, b])).equals(Buffer.from(encodeGif([a, b])))).toBe(true);
  });

  it("rejects empty input and mismatched frames", () => {
    expect(() => encodeGif([])).toThrow();
    expect(() => encodeGif([frame(2, 2, () => [0, 0, 0]), frame(3, 2, () => [0, 0, 0])])).toThrow(/differ/);
  });
});
