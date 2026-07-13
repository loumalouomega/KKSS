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
  chatToHost: "chat:toHost",
  chatToWebview: "chat:toWebview",
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

/** Error classes the chat sidebar renders differently (banner + settings button). */
export type ChatErrorKind = "auth" | "network" | "noKey" | "other";

/** Startup/health state of one MCP server backing the chat agent. */
export interface ChatServerStatus {
  key: "cad" | "mesh" | "kratos";
  /** MCP server display name (e.g. "cad-preview"). */
  name: string;
  state: "starting" | "ready" | "unavailable";
  toolCount?: number;
  /** Short failure description (state: unavailable). */
  error?: string;
}

/**
 * One transcript entry as sent over the wire to the chat renderer. The
 * main-process transcript keeps full tool-result texts for the model;
 * the wire form carries a truncated preview only.
 */
export type ChatWireEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; stopped?: boolean }
  | { kind: "toolCall"; callId: string; server: string; tool: string; argsJson: string }
  | { kind: "toolResult"; callId: string; ok: boolean; preview: string }
  | { kind: "error"; message: string; errorKind: ChatErrorKind };

/** Messages posted by the chat-sidebar renderer. */
export type ChatToHost =
  | { type: "chatReady" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "openSettings" }
  | { type: "hide" };

/** Messages sent to the chat-sidebar renderer. */
export type ChatToWebview =
  | {
      type: "state";
      entries: ChatWireEntry[];
      busy: boolean;
      servers: ChatServerStatus[];
      /** e.g. "Anthropic · claude-opus-4-8" — shown in the header tooltip. */
      providerLabel: string;
    }
  | { type: "entry"; entry: ChatWireEntry }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone"; entry: ChatWireEntry }
  | { type: "busy"; busy: boolean }
  | { type: "servers"; servers: ChatServerStatus[] };

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
export type HomeAction = "preprocessing" | "postprocessing" | "editor" | "settings" | "help";

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
  | { type: "toggleChat" }
  | { type: "editCurrentFile" }
  | { type: "openFile" }
  | { type: "toastButton"; id: number; button: string };

/** Messages sent to the shell toolbar renderer. */
export type ShellToWebview =
  | { type: "screen"; screen: Screen }
  | { type: "title"; view: Mode | "editor"; fileName: string | null; dirty?: boolean }
  | { type: "toast"; id: number; kind: "info" | "warning" | "error" | "progress"; text: string; buttons?: string[] }
  | { type: "toastUpdate"; id: number; text?: string; done?: boolean };
