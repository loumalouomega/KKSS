/**
 * Minimal Electron stand-in for main-process services under vitest, plus the
 * fake WebContents a service sends to. Not a `*.test.ts`, so vitest does not
 * collect it (see vitest.config.ts's `include`).
 *
 * Only what app/main/services/chat needs: an ipcMain that records handlers and
 * can replay a renderer message into them, an `app` that accepts listeners, and
 * a safeStorage with no keyring (secretCodec's plaintext fallback).
 */
export type IpcHandler = (event: { sender: unknown }, payload: unknown) => void;

const handlers = new Map<string, IpcHandler[]>();
const appListeners = new Map<string, Array<() => void>>();

export const electronStub = {
  ipcMain: {
    on(channel: string, handler: IpcHandler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
  },
  app: {
    on(event: string, listener: () => void) {
      const list = appListeners.get(event) ?? [];
      list.push(listener);
      appListeners.set(event, list);
    },
    getPath: () => "/tmp",
    getVersion: () => "0.0.0-test",
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8"),
  },

  /** Delivers a renderer message. Every registered service sees it; each one's
   *  own sender guard decides whether it is theirs. */
  post(channel: string, sender: unknown, payload: unknown): void {
    for (const handler of handlers.get(channel) ?? []) handler({ sender }, payload);
  },
  emitAppEvent(event: string): void {
    for (const listener of appListeners.get(event) ?? []) listener();
  },
  reset(): void {
    handlers.clear();
    appListeners.clear();
  },
};

/** A WebContents that just records what was pushed to it. */
export function fakeWebContents<T>() {
  const messages: T[] = [];
  const contents = {
    isDestroyed: () => false,
    send: (_channel: string, message: T) => {
      messages.push(message);
    },
  };
  return { contents, messages };
}
