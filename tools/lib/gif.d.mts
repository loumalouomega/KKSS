export interface GifFrame {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}
export function encodeGif(frames: GifFrame[], options?: { delayMs?: number; loop?: number }): Uint8Array;
