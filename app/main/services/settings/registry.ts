/**
 * The settings registry — the single source of truth for every user setting
 * the Settings page shows, the vscode shim's `getConfiguration` serves, and the
 * native menu's quick toggles read.
 *
 * Pure (no Electron, no stateStore): entries are plain data, so the page can be
 * sent the whole schema over IPC, and test/settingsRegistry.test.ts can pin it
 * against both submodules' `contributes.configuration` — every property there
 * must be either an entry here with a `vscode` mapping or listed in
 * NOT_APPLICABLE with its reason. A submodule bump that adds a setting fails
 * that test until KKSS decides what to do with it, the toolPolicy.ts precedent.
 *
 * `storeKey` is the stateStore key. Settings that predate this module keep
 * their original key (cadUpAxis, sceneTheme, meshSummaryThresholdMb, …) so no
 * stored preference is lost. New mesh-backed keys are namespaced `kratos.*`:
 * mesh's globalState maps unprefixed onto the same store (meshHost.ts), and
 * none of its keys use that prefix.
 */

export type SettingType =
  | "boolean"
  | "enum"
  | "string"
  | "number"
  | "color"
  | "path"
  | "stringList"
  | "stringMap"
  | "secret"
  | "action";

/** When a change takes effect — shown next to the control. */
export type SettingApplies = "live" | "nextOpen" | "nextRun" | "nextShell" | "nextStart";

export type SettingCategory =
  | "Appearance"
  | "General"
  | "CAD Viewer"
  | "Mesh Viewer"
  | "Kratos"
  | "Text Editor"
  | "Terminal"
  | "LLM Assistant"
  | "MCP Server"
  | "Cloud Accounts"
  | "Advanced";

export const CATEGORIES: readonly SettingCategory[] = [
  "Appearance",
  "General",
  "CAD Viewer",
  "Mesh Viewer",
  "Kratos",
  "Text Editor",
  "Terminal",
  "LLM Assistant",
  "MCP Server",
  "Cloud Accounts",
  "Advanced",
];

export type SettingValue = boolean | number | string | string[] | Record<string, string>;

export interface SettingAction {
  id: string;
  label: string;
  /** Rendered as the primary (filled) button. */
  primary?: boolean;
}

export interface SettingEntry {
  /** VS Code-style dotted id — shown on the page and matched by search. */
  id: string;
  label: string;
  category: SettingCategory;
  type: SettingType;
  description: string;
  /** stateStore key (or secrets.ts key for `secret`). Absent for `action`. */
  storeKey?: string;
  default?: SettingValue;
  enum?: ReadonlyArray<string | number>;
  enumLabels?: readonly string[];
  min?: number;
  max?: number;
  integer?: boolean;
  /** `path` only: what the Browse… button picks. */
  pathKind?: "file" | "folder";
  placeholder?: string;
  applies?: SettingApplies;
  /** Buttons on the row, dispatched to main as `action {id, action}`. */
  actions?: readonly SettingAction[];
  /** The `workspace.getConfiguration(section).get(key)` this entry answers. */
  vscode?: { section: string; key: string };
}

/**
 * Contributed configuration properties KKSS deliberately does not surface.
 * test/settingsRegistry.test.ts requires every other property of both
 * submodules' package.json to have a registry entry.
 */
export const NOT_APPLICABLE: Readonly<Record<string, string>> = {
  "kratos.showWhatsNew":
    "Read only by mesh's activate(), which KKSS never calls; KKSS's own What's New toggle is general.showWhatsNew.",
  "kratos.preview.autoSave":
    "Only relevant with VS Code's files.autoSave on; KKSS has no auto-save loop, so no automatic save is ever attempted.",
  "kratos.run.launchMode":
    "The `terminal` mode needs window.createTerminal, which the shim deliberately refuses; runs always use the tracked child process.",
};

/** Terminal shell choices for this platform. `""` = platform default. */
function shellChoices(platform: string): { values: string[]; labels: string[] } {
  return platform === "win32"
    ? { values: ["", "cmd.exe"], labels: ["PowerShell (default)", "Command Prompt"] }
    : { values: ["", "/bin/bash", "/bin/zsh"], labels: ["System default ($SHELL)", "bash", "zsh"] };
}

/** UI themes: the resolved kinds are VS Code's own body classes (uiTheme.ts). */
export const UI_THEMES = ["system", "dark", "light", "hcDark", "hcLight"] as const;
export type UiThemeSetting = (typeof UI_THEMES)[number];

/** Must match windows.ts's ZOOM_PRESETS (pinned by the registry test). */
export const ZOOM_CHOICES = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;

export const CLOUD_PROVIDERS = [
  { id: "gdrive", label: "Google Drive" },
  { id: "dropbox", label: "Dropbox" },
  { id: "onedrive", label: "OneDrive" },
] as const;

export function buildRegistry(platform: string = process.platform): SettingEntry[] {
  const shells = shellChoices(platform);
  const entries: SettingEntry[] = [
    // ---- Appearance ---------------------------------------------------------
    {
      id: "appearance.uiTheme",
      label: "UI Theme",
      category: "Appearance",
      type: "enum",
      storeKey: "uiTheme",
      default: "system",
      enum: UI_THEMES,
      enumLabels: ["Follow system", "Dark", "Light", "High contrast (dark)", "High contrast (light)"],
      applies: "live",
      description:
        "Colour theme of the whole application — menus, panels, both viewers' chrome and both 3D scenes " +
        "(the mesh scene when its 3D Scene Theme is Auto).",
    },
    {
      id: "appearance.sceneTheme",
      label: "3D Scene Theme",
      category: "Appearance",
      type: "enum",
      storeKey: "sceneTheme",
      default: "auto",
      enum: ["auto", "dark", "light", "scientific"],
      enumLabels: ["Auto (follow UI theme)", "Dark", "Light", "Scientific"],
      applies: "nextOpen",
      description: "Background and palette of the mesh viewer's 3D scene. Shared with the mesh viewer's own theme toggle.",
    },
    {
      id: "appearance.fontFamily",
      label: "UI Font Family",
      category: "Appearance",
      type: "string",
      storeKey: "uiFontFamily",
      default: "",
      placeholder: "System UI font",
      applies: "live",
      description: "CSS font-family for the application chrome. Empty uses the system UI font.",
    },
    {
      id: "appearance.fontSize",
      label: "UI Font Size",
      category: "Appearance",
      type: "number",
      storeKey: "uiFontSize",
      default: 13,
      min: 10,
      max: 20,
      integer: true,
      applies: "live",
      description: "Base font size (px) for the application chrome and both viewers' panels.",
    },
    {
      id: "appearance.zoom",
      label: "Interface Scale",
      category: "Appearance",
      type: "enum",
      storeKey: "uiZoom",
      default: 1,
      enum: ZOOM_CHOICES,
      enumLabels: ZOOM_CHOICES.map((z) => `${Math.round(z * 100)}%`),
      applies: "live",
      description: "Zoom factor applied to every view, chrome included (View ▸ Zoom In/Out).",
    },

    // ---- General ------------------------------------------------------------
    {
      id: "general.projectRoot",
      label: "Project Folder",
      category: "General",
      type: "action",
      storeKey: "projectRoot",
      actions: [
        { id: "choose", label: "Choose…" },
        { id: "clear", label: "Clear" },
      ],
      description:
        "Default folder for the terminal, file dialogs and the assistant (File ▸ Open Folder…). It is a default, never a restriction.",
    },
    {
      id: "general.restoreSession",
      label: "Restore Last Session",
      category: "General",
      type: "boolean",
      storeKey: "restoreSession",
      default: true,
      applies: "nextStart",
      description: "Reopen the previous run's documents, screen and panels at launch.",
    },
    {
      id: "general.showWhatsNew",
      label: "Show What's New After Updates",
      category: "General",
      type: "boolean",
      storeKey: "showWhatsNew",
      default: true,
      applies: "nextStart",
      description: "Show the release notes the first time a new version starts. Help ▸ What's New… always works.",
    },
    {
      id: "general.updateChannel",
      label: "Update Channel",
      category: "General",
      type: "enum",
      storeKey: "updateChannel",
      default: "stable",
      enum: ["stable", "prerelease"],
      enumLabels: ["Stable releases", "Include prereleases"],
      applies: "live",
      description: "Which releases Help ▸ About KKSS offers to install.",
    },

    // ---- CAD Viewer (cadPreview.*) -------------------------------------------
    {
      id: "cadPreview.background",
      label: "Background",
      category: "CAD Viewer",
      type: "color",
      storeKey: "cadBackground",
      default: "#1e1e1e",
      applies: "nextOpen",
      vscode: { section: "cadPreview", key: "background" },
      description: "Default 3D view background for newly opened models. The viewer's Appearance swatch still overrides it per session.",
    },
    {
      id: "cadPreview.upAxis",
      label: "Up Axis",
      category: "CAD Viewer",
      type: "enum",
      storeKey: "cadUpAxis",
      default: "y",
      enum: ["y", "z"],
      enumLabels: ["Y up", "Z up"],
      applies: "nextOpen",
      vscode: { section: "cadPreview", key: "upAxis" },
      description: "Default up-axis orientation for newly opened models.",
    },
    {
      id: "cadPreview.showGridAndAxesOnOpen",
      label: "Show Grid & Axes on Open",
      category: "CAD Viewer",
      type: "boolean",
      storeKey: "cadShowGridAndAxesOnOpen",
      default: true,
      applies: "nextOpen",
      vscode: { section: "cadPreview", key: "showGridAndAxesOnOpen" },
      description: "Show the ground grid and axes helper when a model is opened.",
    },
    {
      id: "cadPreview.defaultMeshSizePreset",
      label: "Default Mesh Size",
      category: "CAD Viewer",
      type: "enum",
      storeKey: "cadDefaultMeshSizePreset",
      default: "medium",
      enum: ["coarse", "medium", "fine"],
      enumLabels: ["Coarse", "Medium", "Fine"],
      applies: "nextOpen",
      vscode: { section: "cadPreview", key: "defaultMeshSizePreset" },
      description: "FE mesh element-size preset seeded for models with no saved .mesh.json sidecar.",
    },
    {
      id: "cadPreview.tessellationQuality",
      label: "Tessellation Quality",
      category: "CAD Viewer",
      type: "enum",
      storeKey: "cadTessellationQuality",
      default: "standard",
      enum: ["draft", "standard", "fine"],
      enumLabels: ["Draft (fastest)", "Standard", "Fine (most detail)"],
      applies: "nextRun",
      vscode: { section: "cadPreview", key: "tessellationQuality" },
      description: "B-rep tessellation for STEP/IGES/BREP. Re-read on every edit or reopen. Does not affect FE meshing.",
    },
    {
      id: "cadPreview.openscadBinary",
      label: "OpenSCAD Binary",
      category: "CAD Viewer",
      type: "path",
      pathKind: "file",
      storeKey: "cadOpenscadBinary",
      default: "openscad",
      applies: "nextOpen",
      vscode: { section: "cadPreview", key: "openscadBinary" },
      description: "Executable used to convert .scad to .csg on open. A bare name is looked up on PATH.",
    },

    // ---- Mesh Viewer (kratos.preview / flowgraph) -----------------------------
    {
      id: "kratos.preview.summaryThresholdMb",
      label: "Large-Mesh Summary Threshold (MB)",
      category: "Mesh Viewer",
      type: "number",
      storeKey: "meshSummaryThresholdMb",
      default: 250,
      min: 0,
      applies: "nextOpen",
      vscode: { section: "kratos", key: "preview.summaryThresholdMb" },
      description:
        "Meshes above this size open as a header summary (counts, blocks, fields) with an “Open full mesh anyway” button. 0 always loads in full.",
    },
    {
      id: "kratos.flowgraph.splitOrientation",
      label: "Flowgraph Split",
      category: "Mesh Viewer",
      type: "enum",
      storeKey: "kratos.flowgraph.splitOrientation",
      default: "horizontal",
      enum: ["horizontal", "vertical"],
      enumLabels: ["Below the 3D view", "Beside the 3D view"],
      applies: "nextOpen",
      vscode: { section: "kratos.flowgraph", key: "splitOrientation" },
      description: "Where the Flowgraph problemtype's node editor opens relative to the 3D view.",
    },

    // ---- Kratos -------------------------------------------------------------
    {
      id: "kratos.pythonPath",
      label: "Python Interpreter",
      category: "Kratos",
      type: "path",
      pathKind: "file",
      storeKey: "kratos.pythonPath",
      default: "",
      placeholder: platform === "win32" ? "python" : "python3",
      applies: "nextRun",
      vscode: { section: "kratos", key: "pythonPath" },
      description: "Python used to run `python MainKratos.py` for a problemtype case. Empty uses python3 (python on Windows).",
    },
    {
      id: "kratos.installPath",
      label: "Kratos Install",
      category: "Kratos",
      type: "path",
      pathKind: "folder",
      storeKey: "kratos.installPath",
      default: "",
      placeholder: "pip-installed Kratos",
      applies: "nextRun",
      vscode: { section: "kratos", key: "installPath" },
      description:
        "Root of a compiled Kratos install, or a source checkout built in-tree. Added to PYTHONPATH and the shared-library path for case runs and the Kratos assistant tools.",
    },
    {
      id: "kratos.extraEnv",
      label: "Extra Environment",
      category: "Kratos",
      type: "stringMap",
      storeKey: "kratos.extraEnv",
      default: {},
      applies: "nextRun",
      vscode: { section: "kratos", key: "extraEnv" },
      description: "Extra environment variables for Kratos runs and the Kratos assistant tools. They override computed values.",
    },
    {
      id: "kratos.problemtypes.extraPaths",
      label: "Problemtype Folders",
      category: "Kratos",
      type: "stringList",
      storeKey: "kratos.problemtypes.extraPaths",
      default: [".kratos/problemtypes"],
      applies: "nextOpen",
      vscode: { section: "kratos", key: "problemtypes.extraPaths" },
      description:
        "Folders (relative to the project folder) scanned for user problemtypes. Only used once a project folder is chosen.",
    },
    {
      id: "kratos.run.stopOnWindowClose",
      label: "Stop Runs on Quit",
      category: "Kratos",
      type: "boolean",
      storeKey: "kratos.run.stopOnWindowClose",
      default: true,
      applies: "live",
      vscode: { section: "kratos", key: "run.stopOnWindowClose" },
      description: "Kill running solvers when KKSS quits. Off leaves them running and re-adopts them on the next launch.",
    },
    {
      id: "kratos.environment",
      label: "Simulation Environment",
      category: "Kratos",
      type: "action",
      actions: [{ id: "check", label: "Check simulation environment" }],
      description: "Check manual and assistant runtimes independently, without installing software. Results appear on Home.",
    },
    {
      id: "kratos.tools",
      label: "Kratos Assistant Tools",
      category: "Kratos",
      type: "action",
      actions: [{ id: "restart", label: "Restart with current environment" }],
      description: "The assistant's Kratos tool server reads the environment above when it starts. Restart it to apply a change now.",
    },

    // ---- Text Editor ----------------------------------------------------------
    {
      id: "editor.fontSize",
      label: "Font Size",
      category: "Text Editor",
      type: "number",
      storeKey: "editor.fontSize",
      default: 13,
      min: 8,
      max: 32,
      integer: true,
      applies: "live",
      description: "Text editor font size (px).",
    },
    {
      id: "editor.fontFamily",
      label: "Font Family",
      category: "Text Editor",
      type: "string",
      storeKey: "editor.fontFamily",
      default: "",
      placeholder: "Default monospace",
      applies: "live",
      description: "CSS font-family for the text editor. Empty uses the default monospace stack.",
    },
    {
      id: "editor.tabSize",
      label: "Tab Size",
      category: "Text Editor",
      type: "number",
      storeKey: "editor.tabSize",
      default: 4,
      min: 1,
      max: 8,
      integer: true,
      applies: "live",
      description: "Width of a tab and of one indentation level.",
    },
    {
      id: "editor.wordWrap",
      label: "Word Wrap",
      category: "Text Editor",
      type: "boolean",
      storeKey: "editor.wordWrap",
      default: false,
      applies: "live",
      description: "Wrap long lines at the editor width instead of scrolling horizontally.",
    },
    {
      id: "editor.lineNumbers",
      label: "Line Numbers",
      category: "Text Editor",
      type: "boolean",
      storeKey: "editor.lineNumbers",
      default: true,
      applies: "live",
      description: "Show the line-number gutter.",
    },

    // ---- Terminal -------------------------------------------------------------
    {
      id: "terminal.shell",
      label: "Shell",
      category: "Terminal",
      type: "enum",
      storeKey: "terminalShell",
      default: "",
      enum: shells.values,
      enumLabels: shells.labels,
      applies: "nextShell",
      description: "Shell started by the embedded terminal.",
    },
    {
      id: "terminal.fontSize",
      label: "Font Size",
      category: "Terminal",
      type: "number",
      storeKey: "terminal.fontSize",
      default: 13,
      min: 8,
      max: 32,
      integer: true,
      applies: "live",
      description: "Terminal font size (px).",
    },
    {
      id: "terminal.fontFamily",
      label: "Font Family",
      category: "Terminal",
      type: "string",
      storeKey: "terminal.fontFamily",
      default: "",
      placeholder: "Consolas, 'Courier New', monospace",
      applies: "live",
      description: "CSS font-family for the terminal. Empty uses the default monospace stack.",
    },
    {
      id: "terminal.scrollback",
      label: "Scrollback Lines",
      category: "Terminal",
      type: "number",
      storeKey: "terminal.scrollback",
      default: 5000,
      min: 0,
      max: 100000,
      integer: true,
      applies: "live",
      description: "Lines kept above the visible terminal area.",
    },
    {
      id: "terminal.cursorStyle",
      label: "Cursor Style",
      category: "Terminal",
      type: "enum",
      storeKey: "terminal.cursorStyle",
      default: "block",
      enum: ["block", "underline", "bar"],
      enumLabels: ["Block", "Underline", "Bar"],
      applies: "live",
      description: "Shape of the terminal cursor.",
    },
    {
      id: "terminal.cursorBlink",
      label: "Cursor Blink",
      category: "Terminal",
      type: "boolean",
      storeKey: "terminal.cursorBlink",
      default: true,
      applies: "live",
      description: "Blink the terminal cursor.",
    },

    // ---- LLM Assistant --------------------------------------------------------
    {
      id: "llm.provider",
      label: "Provider",
      category: "LLM Assistant",
      type: "enum",
      storeKey: "llmProvider",
      default: "anthropic",
      enum: ["anthropic", "openai", "codex", "claude-code"],
      enumLabels: ["Anthropic (Claude)", "OpenAI-compatible", "ChatGPT subscription (Codex)", "Claude subscription (Claude Code)"],
      applies: "live",
      description: "Which backend the chat sidebar talks to.",
    },
    {
      id: "llm.toolApproval",
      label: "Tool Approval",
      category: "LLM Assistant",
      type: "enum",
      storeKey: "llmToolApproval",
      default: "askOnWrite",
      enum: ["askOnWrite", "askAlways", "never"],
      enumLabels: ["Ask before tools that change files", "Ask before every tool", "Never ask"],
      applies: "live",
      description: "When the assistant must ask before running a tool. “Never ask” is confirmed once.",
    },
    {
      id: "llm.anthropicKey",
      label: "Anthropic API Key",
      category: "LLM Assistant",
      type: "secret",
      storeKey: "llmKeyAnthropic",
      placeholder: "sk-ant-…",
      applies: "live",
      description: "Stored encrypted with the operating system's keychain. Never shown again once saved.",
    },
    {
      id: "llm.anthropicModel",
      label: "Anthropic Model",
      category: "LLM Assistant",
      type: "string",
      storeKey: "llmModelAnthropic",
      default: "",
      placeholder: "Default model",
      applies: "live",
      description: "Model id for the Anthropic provider. Empty uses KKSS's default.",
    },
    {
      id: "llm.openaiKey",
      label: "OpenAI-compatible API Key",
      category: "LLM Assistant",
      type: "secret",
      storeKey: "llmKeyOpenai",
      placeholder: "sk-… (empty for keyless backends such as Ollama)",
      applies: "live",
      description: "Stored encrypted. Never shown again once saved.",
    },
    {
      id: "llm.openaiBaseUrl",
      label: "OpenAI-compatible Base URL",
      category: "LLM Assistant",
      type: "string",
      storeKey: "llmOpenaiBaseUrl",
      default: "",
      placeholder: "https://api.openai.com/v1",
      applies: "live",
      description: "Endpoint for the OpenAI-compatible provider (OpenAI, Ollama, vLLM, llama.cpp, …).",
    },
    {
      id: "llm.openaiModel",
      label: "OpenAI-compatible Model",
      category: "LLM Assistant",
      type: "string",
      storeKey: "llmModelOpenai",
      default: "",
      placeholder: "Default model",
      applies: "live",
      description: "Model id for the OpenAI-compatible provider.",
    },
    {
      id: "llm.codexModel",
      label: "Codex Model",
      category: "LLM Assistant",
      type: "string",
      storeKey: "llmModelCodex",
      default: "",
      placeholder: "Runtime default",
      applies: "live",
      description: "Model for the ChatGPT-subscription (Codex) provider.",
    },
    {
      id: "llm.codexExecutable",
      label: "Codex Executable",
      category: "LLM Assistant",
      type: "path",
      pathKind: "file",
      storeKey: "llmCodexExecutable",
      default: "",
      placeholder: "Automatic detection",
      applies: "live",
      description: "Absolute path to the codex executable.",
    },
    {
      id: "llm.claudeCodeModel",
      label: "Claude Code Model",
      category: "LLM Assistant",
      type: "string",
      storeKey: "llmModelClaudeCode",
      default: "",
      placeholder: "Runtime default",
      applies: "live",
      description: "Model for the Claude-subscription (Claude Code) provider.",
    },
    {
      id: "llm.claudeCodeExecutable",
      label: "Claude Code Executable",
      category: "LLM Assistant",
      type: "path",
      pathKind: "file",
      storeKey: "llmClaudeCodeExecutable",
      default: "",
      placeholder: "Automatic detection",
      applies: "live",
      description: "Absolute path to the claude executable.",
    },

    // ---- MCP Server -----------------------------------------------------------
    {
      id: "mcpServer.enabled",
      label: "Enable External Access",
      category: "MCP Server",
      type: "boolean",
      storeKey: "metaServerEnabled",
      default: false,
      applies: "live",
      description:
        "Expose the CAD, mesh and Kratos tools over a localhost HTTP MCP endpoint for an external LLM client. Bearer-token protected.",
    },
    {
      id: "mcpServer.port",
      label: "Port",
      category: "MCP Server",
      type: "number",
      storeKey: "metaServerPort",
      default: 7391,
      min: 1,
      max: 65535,
      integer: true,
      applies: "nextStart",
      description: "Localhost port. Applies the next time the server is enabled.",
    },
    {
      id: "mcpServer.token",
      label: "Address & Token",
      category: "MCP Server",
      type: "action",
      actions: [
        { id: "copy", label: "Copy address & token" },
        { id: "regenerate", label: "Regenerate token…" },
      ],
      description: "Copy the client configuration, or rotate the bearer token (connected clients must be updated).",
    },

    // ---- Cloud Accounts -------------------------------------------------------
    ...CLOUD_PROVIDERS.flatMap((p): SettingEntry[] => [
      {
        id: `cloud.${p.id}.clientId`,
        label: `${p.label} Client ID`,
        category: "Cloud Accounts",
        type: "string",
        storeKey: `cloud.${p.id}.clientId`,
        default: "",
        applies: "live",
        description: `Your own ${p.label} OAuth desktop-app client ID. KKSS ships none.`,
      },
      {
        id: `cloud.${p.id}.clientSecret`,
        label: `${p.label} Client Secret`,
        category: "Cloud Accounts",
        type: "secret",
        storeKey: `cloud.${p.id}.clientSecret`,
        applies: "live",
        description: "Only needed where the provider issues one for desktop clients. Stored encrypted.",
      },
      {
        id: `cloud.${p.id}.account`,
        label: `${p.label} Account`,
        category: "Cloud Accounts",
        type: "action",
        actions: [
          { id: "connect", label: "Connect…", primary: true },
          { id: "disconnect", label: "Disconnect" },
        ],
        description: "Sign in through the browser (PKCE, loopback redirect).",
      },
    ]),
    {
      id: "cloud.cacheLimitMb",
      label: "Cache Size Limit (MB)",
      category: "Cloud Accounts",
      type: "number",
      storeKey: "cloudCacheLimitMb",
      default: 2048,
      min: 1,
      integer: true,
      applies: "live",
      description: "Local staging cache for cloud documents. Open documents are never evicted.",
    },
    {
      id: "cloud.cache",
      label: "Cloud Cache",
      category: "Cloud Accounts",
      type: "action",
      actions: [{ id: "clear", label: "Clear cache…" }],
      description: "Delete every cached cloud document that is not currently open.",
    },

    // ---- Advanced -------------------------------------------------------------
    {
      id: "kratos.flowgraph.assetPathOverride",
      label: "Flowgraph Asset Override",
      category: "Advanced",
      type: "path",
      pathKind: "folder",
      storeKey: "kratos.flowgraph.assetPathOverride",
      default: "",
      placeholder: "Bundled Flowgraph",
      applies: "nextStart",
      vscode: { section: "kratos.flowgraph", key: "assetPathOverride" },
      description:
        "Development only: serve a local @kratos-flowgraph/flowgraph checkout instead of the bundled one. Applies when the Flowgraph server next starts.",
    },
  ];
  return entries;
}

let cached: SettingEntry[] | undefined;
/** The registry for the running platform (memoised). */
export function registry(): SettingEntry[] {
  return (cached ??= buildRegistry());
}

export function entryById(id: string): SettingEntry | undefined {
  return registry().find((e) => e.id === id);
}

/** The entry answering `getConfiguration(section).get(key)`, if any. */
export function entryForVscode(section: string | undefined, key: string): SettingEntry | undefined {
  const full = section ? `${section}.${key}` : key;
  return registry().find((e) => e.vscode && `${e.vscode.section}.${e.vscode.key}` === full);
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Coerces a raw stored/submitted value to the entry's type. Returns undefined
 * when it is invalid — callers then fall back to the default. Never throws.
 *
 * Numbers are also accepted as numeric strings: the native menu's old
 * promptValue stored meshSummaryThresholdMb and metaServerPort as strings.
 */
export function normalize(entry: SettingEntry, raw: unknown): SettingValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  switch (entry.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return undefined;
      if (entry.integer && !Number.isInteger(n)) return undefined;
      if (entry.min !== undefined && n < entry.min) return undefined;
      if (entry.max !== undefined && n > entry.max) return undefined;
      return n;
    }
    case "enum": {
      const values = entry.enum ?? [];
      const match = values.find((v) => v === raw || (typeof v === "number" && typeof raw === "string" && String(v) === raw));
      return match;
    }
    case "color":
      return typeof raw === "string" && HEX_COLOR.test(raw) ? raw.toLowerCase() : undefined;
    case "string":
    case "path":
      return typeof raw === "string" ? raw : undefined;
    case "stringList":
      return Array.isArray(raw) && raw.every((s) => typeof s === "string") ? [...raw] : undefined;
    case "stringMap":
      return raw && typeof raw === "object" && !Array.isArray(raw) &&
        Object.values(raw).every((v) => typeof v === "string")
        ? { ...(raw as Record<string, string>) }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * What to persist for a submitted value: the normalized value, or `undefined`
 * (delete the key) when it equals the default or is an empty string/path —
 * the menu's old "empty clears" contract, so a cleared field falls back to the
 * default rather than pinning "". Returns `{ok:false}` for an invalid value.
 */
export function toStored(entry: SettingEntry, raw: unknown): { ok: true; value: SettingValue | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  if ((entry.type === "string" || entry.type === "path") && typeof raw === "string") {
    const trimmed = raw.trim();
    return { ok: true, value: trimmed === "" || trimmed === entry.default ? undefined : trimmed };
  }
  const value = normalize(entry, raw);
  if (value === undefined) return { ok: false };
  return { ok: true, value: sameValue(value, entry.default) ? undefined : value };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The effective value for display: stored (if valid), else the default. */
export function effective(entry: SettingEntry, stored: unknown): SettingValue | undefined {
  return normalize(entry, stored) ?? entry.default;
}
