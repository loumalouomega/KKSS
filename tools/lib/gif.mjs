/**
 * Dependency-free GIF89a encoder for the docs animation pipeline.
 *
 * Pure JS on purpose: a second native module (or anything with a rebuild step)
 * is ruled out by CLAUDE.md, and ~150 lines is cheaper than a devDependency.
 * One global palette is shared by every frame (median cut over a 5-bit-per-
 * channel histogram), pixels are mapped to their nearest entry without
 * dithering, and every step is order-stable, so identical input frames always
 * produce byte-identical output — the committed GIFs stay reproducible.
 */

/** @typedef {{width: number, height: number, rgba: Uint8Array | Uint8ClampedArray}} GifFrame */

const key15 = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Median-cut palette (<= 256 colours) over every pixel of every frame. */
function buildPalette(frames) {
  const hist = new Map();
  for (const { rgba } of frames) {
    for (let i = 0; i < rgba.length; i += 4) {
      const k = key15(rgba[i], rgba[i + 1], rgba[i + 2]);
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
  }
  // Sorted so Map insertion order (frame order) never influences the result.
  const entries = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => ({
    k, n, c: [((k >> 10) & 31) << 3 | 4, ((k >> 5) & 31) << 3 | 4, (k & 31) << 3 | 4],
  }));
  const boxes = [entries];
  while (boxes.length < 256) {
    let best = -1, bestSpan = 0, bestAxis = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let axis = 0; axis < 3; axis++) {
        let lo = 255, hi = 0;
        for (const e of box) { lo = Math.min(lo, e.c[axis]); hi = Math.max(hi, e.c[axis]); }
        if (hi - lo > bestSpan) { bestSpan = hi - lo; best = i; bestAxis = axis; }
      }
    });
    if (best < 0) break;
    const box = boxes[best].slice().sort((a, b) => a.c[bestAxis] - b.c[bestAxis] || a.k - b.k);
    const total = box.reduce((s, e) => s + e.n, 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) { acc += box[i].n; cut = i + 1; if (acc * 2 >= total) break; }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    const total = box.reduce((s, e) => s + e.n, 0);
    return [0, 1, 2].map((a) => Math.round(box.reduce((s, e) => s + e.c[a] * e.n, 0) / total));
  });
}

function indexFrame(rgba, palette, cache) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const k = key15(rgba[i], rgba[i + 1], rgba[i + 2]);
    let idx = cache.get(k);
    if (idx === undefined) {
      const r = ((k >> 10) & 31) << 3 | 4, g = ((k >> 5) & 31) << 3 | 4, b = (k & 31) << 3 | 4;
      let bestD = Infinity;
      idx = 0;
      palette.forEach((c, j) => {
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < bestD) { bestD = d; idx = j; }
      });
      cache.set(k, idx);
    }
    out[p] = idx;
  }
  return out;
}

/** Variable-width LZW as GIF specifies it, emitted as <=255-byte sub-blocks. */
function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const bytes = [];
  let bitBuf = 0, bitCount = 0;
  const write = (code, size) => {
    bitBuf |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) { bytes.push(bitBuf & 255); bitBuf >>>= 8; bitCount -= 8; }
  };
  let dict = new Map(), next = eoi + 1, size = minCodeSize + 1;
  write(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i], k = (prefix << 8) | c, hit = dict.get(k);
    if (hit !== undefined) { prefix = hit; continue; }
    write(prefix, size);
    if (next < 4096) {
      dict.set(k, next++);
      if (next - 1 > (1 << size) - 1 && size < 12) size++;
    } else {
      write(clear, size);
      dict = new Map(); next = eoi + 1; size = minCodeSize + 1;
    }
    prefix = c;
  }
  write(prefix, size);
  write(eoi, size);
  if (bitCount > 0) bytes.push(bitBuf & 255);
  const out = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out.push(n);
    for (let j = 0; j < n; j++) out.push(bytes[i + j]);
  }
  out.push(0);
  return out;
}

/**
 * @param {GifFrame[]} frames  Same-sized RGBA frames (at least one).
 * @param {{delayMs?: number, loop?: number}} [options]  `loop` 0 = forever.
 * @returns {Uint8Array}
 */
export function encodeGif(frames, { delayMs = 100, loop = 0 } = {}) {
  if (!frames.length) throw new Error("encodeGif: no frames");
  const { width, height } = frames[0];
  for (const f of frames) {
    if (f.width !== width || f.height !== height) throw new Error("encodeGif: frames differ in size");
    if (f.rgba.length !== width * height * 4) throw new Error("encodeGif: bad pixel buffer length");
  }
  if (width > 65535 || height > 65535) throw new Error("encodeGif: frame too large");
  const palette = buildPalette(frames);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const cache = new Map();
  const out = [];
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  out.push(...Buffer.from("GIF89a"));
  u16(width); u16(height);
  out.push(0xf7, 0, 0); // global table, 8-bit colour resolution, 256 entries
  for (const c of palette) out.push(c[0], c[1], c[2]);
  out.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1); u16(loop); out.push(0);
  const delay = Math.max(2, Math.round(delayMs / 10)); // browsers clamp <2 cs to ~10
  for (const f of frames) {
    out.push(0x21, 0xf9, 4, 0, delay & 255, (delay >> 8) & 255, 0, 0);
    out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0);
    for (const b of lzw(indexFrame(f.rgba, palette, cache), 8)) out.push(b);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}
