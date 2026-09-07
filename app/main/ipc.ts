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
  whatsNewInit: "whatsNew:init",
  whatsNewToHost: "whatsNew:toHost",
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

/** Error classes the chat sidebar renders differently (banner + settings button).
 *  Every member must also appear in transcriptStoreCore.ts's ERROR_KINDS, or a
 *  stored error of that kind silently degrades to "other" when it is read back. */
export type ChatErrorKind = "auth" | "network" | "noKey" | "context" | "rateLimit" | "other";

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
/** How a tool call was gated. Absent = never asked (a read-only tool, or
 *  approval turned off) — which is also every entry stored before this shipped. */
export type ChatToolApproval = "allowed" | "denied";

/**
 * A tool call blocked on the user right now.
 *
 * Deliberately **never persisted**: a pending approval is session state, and a
 * hard crash must not replay live-looking buttons wired to a promise that no
 * longer exists. It rides `state.pendingApproval` instead, so a renderer reload
 * *resumes* a blocked turn rather than stranding it.
 */
export interface ChatPendingApproval {
  callId: string;
  server: string;
  tool: string;
  argsJson: string;
  /** Why it is being asked — drives the prompt's explanation line. */
  access: "write" | "unknown";
  /** The tool declares a dry-run parameter, so the prompt offers Validate.
   *  Computed by the main process: the renderer must not carry toolPolicy's
   *  table, and a client-side guess would offer a button that cannot work. */
  dryRunnable: boolean;
  /** A validation already run for this call. Replayed alongside the prompt for
   *  the same reason the prompt itself is: a renderer reload must not silently
   *  discard the answer the user is still looking at. Text only — images would
   *  re-inflate every `state` message. */
  dryRunPreview?: { ok: boolean; text: string };
}

/**
 * One image block from a tool result, forwarded to the sidebar for display.
 *
 * Session-only, and never part of `ChatWireEntry`: the transcript store holds
 * what the *model* was given, and the model only ever sees the `[image content]`
 * placeholder `flattenContent` writes. These ride their own `toolImages`
 * message so a `state` replay — which fires on far more than a reload — does
 * not structured-clone megabytes of base64 on the main thread.
 */
export interface ChatImage {
  mimeType: string;
  dataBase64: string;
}

/**
 * What a conversation has spent, and how much of the window its last request
 * filled. Measured locally and shown to the user; never transmitted anywhere.
 *
 * `contextWindow` and `costUsd` are resolved in the main process from
 * `modelInfo.ts` and are **absent for a model KKSS has no reviewed figures
 * for** — the sidebar then shows token counts alone rather than a wrong number.
 */
export interface ChatUsage {
  /** Cumulative over the conversation. `input` is uncached input only. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Total input of the most recent request — including its cached part, since
   *  that is what actually occupied the window. This, not the cumulative total,
   *  is what "how full is the context" means. */
  lastInput: number;
  model: string;
  contextWindow?: number;
  costUsd?: number;
}

export type ChatWireEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; stopped?: boolean }
  | {
      kind: "toolCall";
      callId: string;
      server: string;
      tool: string;
      argsJson: string;
      approval?: ChatToolApproval;
    }
  | { kind: "toolResult"; callId: string; ok: boolean; preview: string }
  | { kind: "error"; message: string; errorKind: ChatErrorKind };

/**
 * One stored conversation, as listed in the sidebar's history popover.
 * `updatedAt` is epoch ms rather than a formatted string: the renderer formats
 * the relative time itself, so a popover left open does not go stale.
 */
export interface ChatConversationInfo {
  id: string;
  title: string;
  updatedAt: number;
  entryCount: number;
}

/** Messages posted by the chat-sidebar renderer. */
export type ChatToHost =
  | { type: "chatReady" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "approveTool"; callId: string; decision: "allow" | "allowAlways" | "deny" }
  /** Re-runs the blocked call in validate-only mode. Deliberately NOT an
   *  `approveTool` decision: it leaves the gate open so the user answers it
   *  with the report in front of them. */
  | { type: "dryRunTool"; callId: string }
  /** Archives the current conversation and starts an empty one — nothing lost. */
  | { type: "newChat" }
  /** Refresh the history list (the popover was opened). */
  | { type: "listConversations" }
  | { type: "selectConversation"; id: string }
  | { type: "renameConversation"; id: string; title: string }
  | { type: "deleteConversation"; id: string }
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
      /** The conversation `entries` belong to. */
      conversationId: string;
      conversationTitle: string;
      conversations: ChatConversationInfo[];
      /** A tool call blocked on the user right now. Replayed here (and only
       *  here) so a renderer reload or a switch away and back resumes the
       *  prompt instead of leaving the turn stuck with nothing to answer it. */
      pendingApproval?: ChatPendingApproval;
      /** Absent until the conversation has actually spent something. */
      usage?: ChatUsage;
    }
  | { type: "entry"; entry: ChatWireEntry }
  | { type: "approvalRequest"; pending: ChatPendingApproval }
  | { type: "approvalResolved"; callId: string; approval: ChatToolApproval }
  /** Images from a tool result, sent right after its entry (and replayed after
   *  `state`) rather than carried on the entry itself — see ChatImage.
   *  `live` marks a result that has just arrived, which the sidebar expands;
   *  a replay must stay collapsed or a long transcript decodes everything at
   *  once. Main knows which this is — the renderer must not infer it. */
  | { type: "toolImages"; callId: string; images: ChatImage[]; live: boolean }
  | { type: "dryRunResult"; callId: string; ok: boolean; text: string }
  /** Pushed after each model turn; `state` carries the same figures for replay. */
  | { type: "usage"; usage: ChatUsage }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone"; entry: ChatWireEntry }
  | { type: "busy"; busy: boolean }
  | { type: "servers"; servers: ChatServerStatus[] }
  /** History changed without the transcript changing (rename, delete, a title
   *  derived mid-turn, an eviction) — `state` carries the list otherwise. */
  | { type: "conversations"; conversations: ChatConversationInfo[]; activeId: string };

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

/** One CHANGELOG.md release entry, parsed by services/whatsNew.ts. */
export interface ChangelogEntry {
  version: string;
  date: string;
  bullets: string[];
}

/** Static facts sent to the What's New window once its page has loaded. */
export interface WhatsNewInit {
  version: string;
  entries: ChangelogEntry[];
}

/** Messages posted by the What's New dialog renderer. */
export type WhatsNewToHost = { type: "close" };

/** Actions of the home-screen menu buttons (see app/renderer/home/homeConfig.ts). */
export type HomeAction = "preprocessing" | "postprocessing" | "editor" | "settings" | "help";

/**
 * One recents row. Label and folder are formatted in main: the home renderer is
 * a browser bundle and cannot import node:path.
 */
export interface RecentEntry {
  path: string;
  mode: Mode;
  /** File name. */
  label: string;
  /** Containing folder, with $HOME abbreviated — shown as the row's tooltip. */
  description: string;
}

/**
 * The project root, pre-formatted for the renderers (neither can import
 * node:path). `path` is null when no root is explicitly set — an inferred root
 * still drives defaults but is never displayed.
 */
export interface ProjectRootInfo {
  type: "projectRoot";
  path: string | null;
  /** The folder's own name — the toolbar chip and home-screen line. */
  label: string | null;
  /** $HOME-abbreviated full path — the tooltip. */
  display: string | null;
}

/** Messages posted by the home-screen renderer. */
export type HomeToHost =
  | { type: "homeReady" }
  | { type: "action"; action: HomeAction }
  | { type: "openRecent"; path: string; mode: Mode }
  | { type: "clearRecents" }
  | { type: "chooseProjectRoot" }
  | { type: "clearProjectRoot" };

/** Messages pushed to the home-screen renderer. */
export type HomeToWebview = { type: "recents"; entries: RecentEntry[] } | ProjectRootInfo;

/** Messages posted by the shell toolbar renderer. */
export type ShellToHost =
  | { type: "shellReady" }
  | { type: "setMode"; mode: Mode }
  | { type: "goHome" }
  | { type: "toggleTerminal" }
  | { type: "toggleChat" }
  | { type: "editCurrentFile" }
  | { type: "openFile" }
  | { type: "setZoom"; factor: number }
  | { type: "toastButton"; id: number; button: string }
  /** "+" in the tab strip — creates an empty tab for `mode` and focuses it. */
  | { type: "newTab"; mode: Mode }
  /** ✕ on a tab — closes it (no dirty-prompt; see CLAUDE.md's tabs invariant). */
  | { type: "closeTab"; mode: Mode; tabId: string }
  /** Clicking a tab — focuses it. */
  | { type: "selectTab"; mode: Mode; tabId: string }
  /** The toolbar's project-root chip — opens the folder picker. */
  | { type: "chooseProjectRoot" };

/** One tab's shell-visible state (tab strip row). */
export interface ShellTabInfo {
  id: string;
  fileName: string | null;
  dirty?: boolean;
  /** Set when the tab's document is a staging copy of a cloud file. The strip
   *  marks it, so a path under the cache directory is not mistaken for a file
   *  the user can find in their own folders. */
  cloud?: { provider: string; name: string };
}

/** Messages sent to the shell toolbar renderer. */
export type ShellToWebview =
  | { type: "screen"; screen: Screen }
  /** Editor-only — cad/mesh report their per-tab titles via `tabs` instead. */
  | { type: "title"; view: "editor"; fileName: string | null; dirty?: boolean }
  /** Full resync of one mode's tab strip — sent on open/close/focus/rename. */
  | { type: "tabs"; mode: Mode; tabs: ShellTabInfo[]; activeTabId: string | undefined }
  | { type: "zoom"; factor: number }
  | { type: "toast"; id: number; kind: "info" | "warning" | "error" | "progress"; text: string; buttons?: string[] }
  | { type: "toastUpdate"; id: number; text?: string; done?: boolean }
  | ProjectRootInfo;
