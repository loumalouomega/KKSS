/**
 * Typed IPC channel names. Payloads on the cad/mesh channels are the
 * submodule extensions' own protocol message objects, verbatim:
 *  - cad:  cad/src/protocol.ts  (HostToWebview / WebviewToHost)
 *  - mesh: the message table in mesh/CLAUDE.md ("Message protocol")
 */
export type Mode = "cad" | "mesh";

/** Top-level screens: the launch home menu, the two mode views, the editor. */
export type Screen = "home" | "editor" | Mode;

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
  homeToHost: "home:toHost",
  homeToWebview: "home:toWebview",
  aboutInit: "about:init",
  aboutToHost: "about:toHost",
  aboutToWebview: "about:toWebview",
  termToHost: "term:toHost",
  termToWebview: "term:toWebview",
  editorToHost: "editor:toHost",
  editorToWebview: "editor:toWebview",
} as const;

export type EditorLanguage = "json" | "python" | "plain";

/** Messages posted by the text-editor renderer. */
export type EditorToHost =
  | { type: "editorReady" }
  | { type: "openFile" }
  | { type: "saveContent"; content: string; saveAs: boolean }
  | { type: "dirty"; dirty: boolean };

/** Messages sent to the text-editor renderer. */
export type EditorToWebview =
  | { type: "doc"; path: string; content: string; language: EditorLanguage }
  | { type: "saved"; path: string }
  | { type: "requestSave"; saveAs: boolean };

/** Messages posted by the terminal-panel renderer. */
export type TermToHost =
  | { type: "termReady"; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "restart" }
  | { type: "hide" };

/** Messages sent to the terminal-panel renderer. */
export type TermToWebview =
  | { type: "data"; data: string }
  | { type: "exit"; code: number };

/** Static facts sent to the About window once its page has loaded. */
export interface AboutInit {
  version: string;
  author: string;
  packaged: boolean;
  platform: NodeJS.Platform;
}

/** Messages posted by the About dialog renderer. */
export type AboutToHost =
  | { type: "checkUpdates" }
  | { type: "downloadUpdate" }
  | { type: "installUpdate" }
  | { type: "openReleases" }
  | { type: "openDocs" }
  | { type: "close" };

/** Update-check status pushed to the About dialog renderer. */
export type AboutToWebview = {
  type: "status";
  state: "checking" | "upToDate" | "available" | "downloading" | "downloaded" | "error";
  /** Latest published version (state: available/downloading/downloaded). */
  latestVersion?: string;
  /** Download progress 0–100 (state: downloading). */
  percent?: number;
  /** Human-readable detail (state: error). */
  message?: string;
  /** Whether in-app download+install is possible on this install type. */
  canAutoUpdate?: boolean;
};

/** Actions of the home-screen menu buttons (see app/renderer/home/homeConfig.ts). */
export type HomeAction = "preprocessing" | "postprocessing" | "editor" | "help";

/** Messages posted by the home-screen renderer. */
export type HomeToHost =
  | { type: "homeReady" }
  | { type: "action"; action: HomeAction };

/** Messages posted by the shell toolbar renderer. */
export type ShellToHost =
  | { type: "shellReady" }
  | { type: "setMode"; mode: Mode }
  | { type: "goHome" }
  | { type: "toggleTerminal" }
  | { type: "openFile" }
  | { type: "toastButton"; id: number; button: string };

/** Messages sent to the shell toolbar renderer. */
export type ShellToWebview =
  | { type: "screen"; screen: Screen }
  | { type: "title"; view: Mode | "editor"; fileName: string | null; dirty?: boolean }
  | { type: "toast"; id: number; kind: "info" | "warning" | "error" | "progress"; text: string; buttons?: string[] }
  | { type: "toastUpdate"; id: number; text?: string; done?: boolean };
