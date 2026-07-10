/**
 * Typed IPC channel names. Payloads on the cad/mesh channels are the
 * submodule extensions' own protocol message objects, verbatim:
 *  - cad:  cad/src/protocol.ts  (HostToWebview / WebviewToHost)
 *  - mesh: the message table in mesh/CLAUDE.md ("Message protocol")
 */
export type Mode = "cad" | "mesh";

export const channels = {
  /** Webview bundle → host (payload: extension WebviewToHost message). */
  toHost: (mode: Mode) => `${mode}:toHost` as const,
  /** Host → webview bundle (payload: extension HostToWebview message). */
  toWebview: (mode: Mode) => `${mode}:toWebview` as const,
  /** Synchronous initial state for a view page (theme, mode). */
  initialState: (mode: Mode) => `${mode}:initialState` as const,

  shellToHost: "shell:toHost",
  shellToWebview: "shell:toWebview",
  pickerToHost: "picker:toHost",
  pickerInit: "picker:init",
} as const;

/** Messages posted by the shell toolbar renderer. */
export type ShellToHost =
  | { type: "setMode"; mode: Mode }
  | { type: "openFile" }
  | { type: "toastButton"; id: number; button: string };

/** Messages sent to the shell toolbar renderer. */
export type ShellToWebview =
  | { type: "mode"; mode: Mode }
  | { type: "title"; mode: Mode; fileName: string | null }
  | { type: "toast"; id: number; kind: "info" | "warning" | "error" | "progress"; text: string; buttons?: string[] }
  | { type: "toastUpdate"; id: number; text?: string; done?: boolean };
