/**
 * Typed IPC channel names. Payloads on the cad/mesh channels are the
 * submodule extensions' own protocol message objects, verbatim:
 *  - cad:  cad/src/protocol.ts  (HostToWebview / WebviewToHost)
 *  - mesh: the message table in mesh/CLAUDE.md ("Message protocol")
 */
import type { SettingCategory, SettingEntry, SettingValue } from "./services/settings/registry";

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
  fileDrop: "app:dropFile",
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
  jobsToHost: "jobs:toHost",
  jobsToWebview: "jobs:toWebview",
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
  /** `cad`/`mesh`/`kratos`/`pdf` for the built-ins, otherwise the id of a
   *  user- or project-configured server (see userServers.ts for the id rules). */
  key: string;
  /** MCP server display name (e.g. "cad-preview"). */
  name: string;
  /** `disabled`: switched off in the manager. `untrusted`: a project server whose
   *  definition file the user has not (or no longer) trusted — never spawned. */
  state: "starting" | "ready" | "unavailable" | "disabled" | "untrusted";
  /** Absent = built-in. */
  source?: "builtin" | "user" | "project";
  transport?: "stdio" | "http";
  toolCount?: number;
  /** Tools the server advertised that were left out (name unusable for a model provider). */
  skippedTools?: number;
  phase?: "probing" | "installing" | "preparing";
  failure?: "missing-runtime" | "runtime" | "network" | "package" | "timeout" | "installation" | "unknown";
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

/** What a lifecycle hook did to a tool call (hooks.ts). Optional on the entry,
 *  like `approval`, so storing it needs no `CHAT_STORE_VERSION` bump. A hook
 *  can only refuse a call or make it ask — there is no "approved by a hook". */
export interface ChatToolHook {
  name: string;
  decision: "denied" | "ask";
  reason?: string;
}

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
  access: "write" | "unknown" | "hook";
  /** A lifecycle hook forced this prompt (it can ask, never approve). */
  hook?: { name: string; reason?: string };
  /** The tool declares a dry-run parameter, so the prompt offers Validate.
   *  Computed by the main process: the renderer must not carry toolPolicy's
   *  table, and a client-side guess would offer a button that cannot work. */
  dryRunnable: boolean;
  /** Offer "Always allow in project folder": an explicit project root is set,
   *  the tool is a scopable write tool, and every path in *this* call is
   *  inside that root. Computed by main — the renderer carries no policy. */
  scopable?: boolean;
  /** The project folder the grant would be scoped to (shown on the button). */
  scopeRoot?: string;
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

export type ChatAttachmentKind = "image" | "pdf";

/**
 * A file the *user* attached to a message. Unlike `ChatImage` (a tool result the
 * model never sees), these are the model's input, so they are stored with the
 * conversation and sent in the request. The bytes never ride `ChatWireEntry`:
 * the wire entry carries `ChatAttachmentRef`s and the images arrive on their own
 * `userImages` message, for the same reason `toolImages` does.
 */
export interface ChatAttachment {
  /** Stable for the life of the entry, so the sidebar can pair bytes to a bubble. */
  id: string;
  kind: ChatAttachmentKind;
  mimeType: string;
  /** Original file name, when the file had one (a pasted screenshot has none). */
  name?: string;
  dataBase64: string;
}

/** What the renderer sends: main assigns the id and derives the kind. */
export interface ChatAttachmentInput {
  mimeType: string;
  name?: string;
  dataBase64: string;
}

/** The bytes-free form of a `ChatAttachment`. */
export interface ChatAttachmentRef {
  id: string;
  kind: ChatAttachmentKind;
  mimeType: string;
  name?: string;
}

/** Why an attachment kind is unavailable right now. A code, not a sentence: the
 *  renderer maps it through `t()`, which main-process English literals would bypass. */
export type ChatAttachmentRefusal = "subscription" | "gatewayOptIn" | "pdfNeedsMcp";

/**
 * What a conversation has spent, and how much of the window its last request
 * filled. Measured locally and shown to the user; never transmitted anywhere.
 *
 * `contextWindow` and `costUsd` are resolved in the main process from
 * `modelInfo.ts` and are **absent for a model KKSS has no reviewed figures
 * for** — the sidebar then shows token counts alone rather than a wrong number —
 * unless the user entered prices/a window themselves, in which case
 * `userSupplied` is set so the readout can say whose figures they are.
 */
export interface ChatUsage {
  billingMode?: "api" | "subscription" | "mixed";
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
  /** `contextWindow`/`costUsd` came from Settings ▸ LLM Assistant, not the reviewed table. */
  userSupplied?: boolean;
}

export type ChatWireEntry =
  | { kind: "user"; text: string; attachments?: ChatAttachmentRef[]; attachmentsEvicted?: number }
  | { kind: "assistant"; text: string; stopped?: boolean }
  | {
      kind: "toolCall";
      callId: string;
      server: string;
      tool: string;
      argsJson: string;
      approval?: ChatToolApproval;
      hook?: ChatToolHook;
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

/** One row of the sidebar's MCP manager. Never carries an env value or token —
 *  only the names, and whether a token is stored. */
export interface ChatMcpServerRow {
  id: string;
  name: string;
  source: "builtin" | "user" | "project";
  transport: "stdio" | "http";
  state: ChatServerStatus["state"];
  enabled: boolean;
  toolCount?: number;
  skippedTools?: number;
  error?: string;
  /** Built-ins can be restarted but not edited, disabled or removed. */
  editable: boolean;
  command?: string;
  args?: string[];
  envNames?: string[];
  url?: string;
  /** User server: a bearer token is stored. Project server: `tokenEnv` is named. */
  tokenSet?: boolean;
  tokenEnv?: string;
}

/** The project folder's `.kkss/assistant/` definitions and their trust state. */
export interface ChatMcpProject {
  /** The *explicit* project folder, if one is set. */
  root?: string;
  /** `none`: no definition file. `untrusted`: never trusted. `changed`: trusted
   *  before, but the files differ now. `invalid`: unreadable or unsafe file. */
  state: "none" | "untrusted" | "trusted" | "changed" | "invalid";
  shortHash?: string;
  /** Validation problems, shown so a typo is not a silent no-op. */
  errors: string[];
}

export type ChatMcpMark = "read" | "write" | "unknown";

/** What the manager shows about the user's standing instructions, skills and
 *  prompt templates (text-only definitions — see assistantDefs.ts). */
export interface ChatHookInfo {
  name: string;
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "TurnEnd";
  source: "user" | "project";
  match?: string;
  /** The command and its arguments, joined for display only. */
  command: string;
}

export interface ChatAssistantDefs {
  /** Settings ▸ LLM Assistant: when off, nothing below is sent or expanded. */
  enabled: boolean;
  /** Lifecycle hooks (hooks.json). Off in Settings ⇒ none run and none are listed. */
  hooksEnabled: boolean;
  hooks: ChatHookInfo[];
  hookErrors: string[];
  instructions: Array<{ source: "user" | "project"; chars: number; truncated: boolean }>;
  skills: Array<{ name: string; source: "user" | "project"; description: string }>;
  templates: Array<{ name: string; source: "user" | "project"; preview: string }>;
  /** ~tokens the instructions and skill catalog add to every request (uncached). */
  estimatedTokens: number;
  /** Skills beyond the catalog budget that the model is not told about. */
  catalogOmitted: number;
  errors: string[];
}

export interface ChatMcpToolInfo {
  /** The server's own tool name (not namespaced). */
  name: string;
  description?: string;
  mark: ChatMcpMark;
}

/** What the manager's Add/Edit form submits. Secrets flow renderer → main only. */
export interface ChatMcpServerInput {
  id: string;
  name?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  /** `value` undefined keeps the stored value; a string replaces it. Names not
   *  listed are dropped (and their stored secrets deleted). */
  env?: Array<{ name: string; value?: string }>;
  url?: string;
  /** Bearer token: undefined keeps, "" clears, a string replaces. */
  token?: string;
  enabled?: boolean;
}

/** Messages posted by the chat-sidebar renderer. */
export type ChatToHost =
  | { type: "chatReady" }
  | { type: "installKratosRuntime" }
  | { type: "retryKratos" }
  | { type: "send"; text: string; attachments?: ChatAttachmentInput[] }
  | { type: "stop" }
  | { type: "approveTool"; callId: string; decision: "allow" | "allowAlways" | "allowScoped" | "deny" }
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
  /** The composer strip's model picker. Writes the same setting as Settings ▸
   *  LLM Assistant, for the active provider; applies from the next message.
   *  Empty clears it back to the provider default. */
  | { type: "setModel"; model: string }
  | { type: "setThinking"; level: ChatThinking }
  /** MCP manager. Every one is validated in main; a managed (locked) store refuses edits. */
  | { type: "mcpRefresh" }
  /** Create (if needed) and open the folder holding instructions.md, skills/ and prompts/. */
  | { type: "defsOpenFolder" }
  /** The composer text starts with "/": which templates match (answered by `templateHints`). */
  | { type: "templateHints"; typed: string }
  | { type: "mcpSaveServer"; server: ChatMcpServerInput }
  | { type: "mcpRemoveServer"; id: string }
  | { type: "mcpSetEnabled"; id: string; enabled: boolean }
  | { type: "mcpRestart"; id: string }
  | { type: "mcpToolsRequest"; id: string }
  | { type: "mcpSetMark"; id: string; tool: string; mark: ChatMcpMark }
  /** Trust, revoke or re-read the explicit project folder's definitions. Trusting
   *  is a user click only — there is deliberately no model-reachable path to it. */
  | { type: "mcpTrustProject" }
  | { type: "mcpRevokeProject" }
  | { type: "mcpReloadProject" }
  | { type: "hide" };

/** Reasoning effort chosen in the sidebar. `auto` sends nothing new. */
export type ChatThinking = "auto" | "off" | "low" | "high";

/** The composer strip's controls, resolved in main (the renderer carries no model list). */
export interface ChatComposerState {
  provider: "anthropic" | "openai" | "opencode-zen" | "opencode-go" | "codex" | "claude-code";
  /** The model in effect — the stored one, else `defaultModel`; "" for a runtime default. */
  model: string;
  /** The provider's built-in default ("" when the runtime picks). */
  defaultModel: string;
  /** Suggested ids; the renderer adds Default / the current custom value / Other…. */
  choices: string[];
  /** Locked by the environment (managed deployment): shown, not editable. */
  modelManaged: boolean;
  thinking: ChatThinking;
  /** False for the subscription runtimes, which expose no such control to KKSS. */
  thinkingSupported: boolean;
  /** Per kind: `null` = the composer may attach it, otherwise why not. Resolved
   *  in main (provider + model + the image-input setting) — the renderer carries
   *  no policy. */
  attach: { image: ChatAttachmentRefusal | null; pdf: ChatAttachmentRefusal | null };
  /** Whether the optional Kraty face is on (Settings ▸ LLM Assistant). Presentation only. */
  kraty: boolean;
}

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
      /** How many older tool results are cleared from requests, if any. The
       *  sidebar still shows every result in full — this is the disclosure that
       *  the model is no longer being sent them. */
      compactedResults?: number;
    }
  | { type: "entry"; entry: ChatWireEntry }
  /** The composer strip's state. Sent after `state` and again whenever an
   *  `llm*` setting changes elsewhere (Settings page, native menu). */
  | { type: "composer"; composer: ChatComposerState }
  | { type: "approvalRequest"; pending: ChatPendingApproval }
  | { type: "approvalResolved"; callId: string; approval: ChatToolApproval }
  /** A lifecycle hook refused the call or forced its prompt (painted on the chip). */
  | { type: "hookNote"; callId: string; hook: ChatToolHook }
  /** Images from a tool result, sent right after its entry (and replayed after
   *  `state`) rather than carried on the entry itself — see ChatImage.
   *  `live` marks a result that has just arrived, which the sidebar expands;
   *  a replay must stay collapsed or a long transcript decodes everything at
   *  once. Main knows which this is — the renderer must not infer it. */
  | { type: "toolImages"; callId: string; images: ChatImage[]; live: boolean }
  /** Image bytes of user attachments, keyed by `ChatAttachmentRef.id`. Sent after
   *  the entry and replayed after `state` — never inside `ChatWireEntry`. */
  | { type: "userImages"; images: Array<{ id: string; mimeType: string; dataBase64: string }> }
  /** A send main refused before appending anything. The renderer clears its
   *  draft on submit, so this hands the text and the reason back. */
  | { type: "sendRefused"; reason: ChatAttachmentRefusal | "invalid" | "hook"; text: string; detail?: string }
  | { type: "dryRunResult"; callId: string; ok: boolean; text: string }
  /** Pushed after each model turn; `state` carries the same figures for replay. */
  | { type: "usage"; usage: ChatUsage }
  /** Older tool results are being cleared from requests to fit the context
   *  window. Deliberately its own message rather than a field on ChatUsage:
   *  usage is absent whenever the provider reports none, which is the normal
   *  OpenAI-compatible case — precisely where compaction matters most. */
  | { type: "compaction"; count: number }
  | { type: "assistantStart" }
  | { type: "assistantDelta"; text: string }
  | { type: "assistantDone"; entry: ChatWireEntry }
  | { type: "busy"; busy: boolean }
  | { type: "servers"; servers: ChatServerStatus[] }
  | { type: "mcpManager"; rows: ChatMcpServerRow[]; project: ChatMcpProject; managed: boolean }
  | { type: "mcpTools"; id: string; tools: ChatMcpToolInfo[] }
  | { type: "assistantDefs"; defs: ChatAssistantDefs }
  | { type: "templateHints"; typed: string; names: string[] }
  /** A `mcpSaveServer` went through (the form can close). Failures arrive as `mcpError`. */
  | { type: "mcpSaved"; id: string }
  /** Settings ▸ LLM Assistant ▸ MCP Servers → Open: show the manager panel. */
  | { type: "mcpOpen" }
  /** A manager action main refused or could not finish. `code` is mapped through
   *  `t()` in the renderer; `detail` is validation text for the form. */
  | { type: "mcpError"; code: "invalid" | "managed" | "reserved" | "duplicate" | "unknown" | "failed"; detail?: string }
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

/** Static facts sent to the License window once its page has loaded. */
export interface LicenseInit {
  version: string;
  /** The repo LICENSE text beside the bundle (empty when it cannot be read). */
  text: string;
}

/** Messages posted by the License window's renderer. */
export type LicenseToHost = | { type: "close" };

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
  | { type: "checkEnvironment" }
  | { type: "retrySimulationTools"; install: boolean }
  | { type: "workflow"; tool: string; args: Record<string, unknown> }
  | { type: "action"; action: HomeAction }
  | { type: "openRecent"; path: string; mode: Mode }
  | { type: "clearRecents" }
  | { type: "chooseProjectRoot" }
  | { type: "clearProjectRoot" };

/** Messages pushed to the home-screen renderer. */
export type HomeToWebview = { type: "recents"; entries: RecentEntry[] } | ProjectRootInfo
  | { type: "workflowState" | "environmentReport" | "workflowResult"; value: unknown }
  | { type: "workflowBusy"; busy: boolean }
  | { type: "workflowError"; message: string };

/** Messages posted by the shell toolbar renderer. */
export type ShellToHost =
  | { type: "shellReady" }
  | { type: "setMode"; mode: Mode }
  | { type: "goHome" }
  | { type: "toggleTerminal" }
  | { type: "toggleChat" }
  | { type: "toggleJobs" }
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
  | { type: "jobs"; active: number; visible: boolean; stale: boolean }
  /** Which toggleable side/bottom panels are showing — the toolbar buttons'
   *  pressed state. Jobs has its own message above because it also carries a count. */
  | { type: "panels"; terminal: boolean; chat: boolean }
  | { type: "screen"; screen: Screen }
  /** Editor-only — cad/mesh report their per-tab titles via `tabs` instead. */
  | { type: "title"; view: "editor"; fileName: string | null; dirty?: boolean }
  /** Full resync of one mode's tab strip — sent on open/close/focus/rename. */
  | { type: "tabs"; mode: Mode; tabs: ShellTabInfo[]; activeTabId: string | undefined }
  | { type: "zoom"; factor: number }
  | { type: "toast"; id: number; kind: "info" | "warning" | "error" | "progress"; text: string; buttons?: string[] }
  | { type: "toastUpdate"; id: number; text?: string; done?: boolean }
  | ProjectRootInfo;

/** Server-owned simulation records; all timestamps are Unix seconds. */
export interface KratosJob {
  job_id: string;
  case_dir: string;
  parameters_file: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: number;
  started_at?: number;
  finished_at?: number;
  elapsed_seconds?: number;
  progress?: { current_step?: number; current_time?: number };
}
export interface JobsSnapshot {
  type: "state";
  jobs: KratosJob[];
  loading: boolean;
  stale: boolean;
  error?: string;
  servers: ChatServerStatus[];
  selected?: string;
  log?: string;
  logError?: string;
  cancelling: string[];
  cancelErrors: Record<string, string>;
}
export type JobsToHost =
  | { type: "jobsReady" | "refresh" | "hide" | "retryKratos" | "installKratosRuntime" }
  | { type: "select" | "cancel"; jobId: string };

// ---- Settings page (services/settings/settingsWindow.ts) ---------------------

/**
 * Per-row live state. A `secret` row carries only `isSet` — the renderer never
 * receives a secret value, only the fact that one is stored.
 */
export interface SettingsRowState {
  /** The effective value (stored if valid, else the default). */
  value?: SettingValue;
  /** Whether a (non-default) value is stored — drives the reset icon. */
  modified: boolean;
  /** Locked by a KKSS_* environment variable (managedConfig.ts). */
  managed: boolean;
  isSet?: boolean;
  /** One-line status under the control (the project folder, a cloud account). */
  status?: string;
  /** A warning under the control (e.g. an install path that is not Kratos). */
  warning?: string;
  /** Action ids currently unavailable (e.g. Disconnect while not connected). */
  disabledActions?: string[];
}

export type SettingsToWebview =
  | { type: "schema"; categories: readonly SettingCategory[]; entries: SettingEntry[] }
  | { type: "rows"; rows: Record<string, SettingsRowState> }
  | { type: "error"; id: string; message: string };

export type SettingsToHost =
  | { type: "settingsReady" }
  | { type: "set"; id: string; value: unknown }
  | { type: "reset"; id: string }
  | { type: "browse"; id: string }
  | { type: "action"; id: string; action: string };
