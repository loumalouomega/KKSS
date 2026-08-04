/**
 * Chat sidebar backend: owns the transcript and the agent loop (provider
 * turn → MCP tool calls → repeat), bridged to app/renderer/chat/ over
 * chat:toHost / chat:toWebview. All network and child-process work lives
 * here — the renderer keeps the strict CSP and never sees an API key.
 *
 * Same service conventions as terminal.ts/editor.ts: ipcMain handler with a
 * sender guard in the constructor, attach() to point at the sidebar view,
 * full-state replay on chatReady, dispose() on will-quit.
 */
import { app, ipcMain, WebContents } from "electron";
import type { ChatErrorKind, ChatToHost, ChatToWebview } from "../../ipc";
import { stateStore } from "../stateStore";
import { getSecret } from "./secrets";
import type { McpManager } from "./mcpManager";
import type { McpHub } from "./mcpHub";
import { ChatEntry, toWire } from "./transcript";
import { Provider, ProviderError } from "./providers/types";
import { createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./providers/anthropic";
import { createOpenAiCompatProvider, DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_MODEL } from "./providers/openaiCompat";

/** Settings ▸ LLM Assistant — stateStore keys. */
export const LLM_KEYS = {
  provider: "llmProvider", // "anthropic" | "openai"
  anthropicModel: "llmModelAnthropic",
  anthropicKey: "llmKeyAnthropic",
  openaiModel: "llmModelOpenai",
  openaiKey: "llmKeyOpenai",
  openaiBaseUrl: "llmOpenaiBaseUrl",
} as const;

export interface LlmSettings {
  provider: "anthropic" | "openai";
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export function readLlmSettings(): LlmSettings {
  const provider = stateStore.get<string>(LLM_KEYS.provider, "anthropic") === "openai" ? "openai" : "anthropic";
  if (provider === "anthropic") {
    return {
      provider,
      model: stateStore.get<string>(LLM_KEYS.anthropicModel) || DEFAULT_ANTHROPIC_MODEL,
      baseUrl: "",
      apiKey: getSecret(LLM_KEYS.anthropicKey),
    };
  }
  return {
    provider,
    model: stateStore.get<string>(LLM_KEYS.openaiModel) || DEFAULT_OPENAI_MODEL,
    baseUrl: stateStore.get<string>(LLM_KEYS.openaiBaseUrl) || DEFAULT_OPENAI_BASE_URL,
    apiKey: getSecret(LLM_KEYS.openaiKey),
  };
}

/** Byte-stable across turns (prompt-cache friendly) — volatile context goes
 *  into the latest user message instead. */
const SYSTEM_PROMPT = `You are the KKSS assistant, embedded in KKSS (Keep Kratos Simple Stupid), \
a desktop app for pre- and post-processing Kratos Multiphysics simulations. \
You control the app's engines through tools from three MCP servers, namespaced by prefix:
- cad__* (cad-preview): headless CAD editing — load STEP/IGES/BREP and STL/OBJ/PLY/glTF models, plus \
VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA imported through meshio++ as geometry-only boundary surfaces; apply \
parametric edit operations via sidecar files (including run_parametric_script for declarative, re-runnable \
part scripts), define FEM sub-model-parts, and generate and export meshes with Gmsh — with optional unit \
conversion (mm/cm/m/in/ft) on export, and MED/CGNS/XDMF mesh targets Gmsh's own writers cannot produce. \
It also answers questions about a model without changing it: get_mass_properties (volume, area, centre of \
mass, moments of inertia), inspect and measure (bounding-box facts), measure_exact (true OCCT distance, \
edge length, radius), check_interference (clash detection between solids or Parts), compare_models (a \
geometric diff of two models, optionally with rendered images), render_snapshot (headless multi-view PNGs), \
and search_standard_parts / download_standard_part (fasteners and other standard parts from step.parts, \
the one tool family that reaches the network). Call cad__describe_capabilities before your first \
cad__apply_edit_ops to learn the operation catalog.
- mesh__* (kratos-mdpa): mesh inspection and transformation — info, quality metrics, and mesh size \
(nodal Kratos NODAL_H + element edge length with box-whisker stats, std, and IQR small/large outlier ids) for MDPA, \
VTK, STL/OBJ/PLY and 39 extended formats read through meshio++ (Gmsh .msh, Abaqus .inp, Nastran, UNV, Medit, \
Netgen, SU2, XDMF, Exodus .e/.exo/.ex2, CGNS, MOAB .h5m, Salome .med, tetgen, EnSight Gold, Triangle, …), \
36 of them writable, format conversion (pass inputFormat/outputFormat to force a meshio++ reader/writer when \
the extension is ambiguous; pass timeStep to pick a step of a multi-step file — Exodus and Salome MED, but \
only Exodus reports its available times as mesh__mesh_info's timeValues, so a MED step count is discoverable \
only by asking for one), boundary-skin extraction, and Kratos case setup \
(problemtypes, ProjectParameters, materials). mesh__mesh_transform applies an undoable op list: MMG remeshing \
(incl. mode "expr", a formula over the nodal size h, the whole-mesh size statistics and the coordinates, with \
optional per-SubModelPart overrides) and level-set splitting, smoothing, RCM/Morton/Hilbert renumbering, \
space-filling-curve partitioning, uniform refinement, linear↔quadratic conversion, simplexification, box/plane \
cropping, a field calculator and nodal↔elemental averaging, mesh merging, and the RADIUS of SPHERE/particle \
elements (mesh__mesh_info's spheres section tells you whether a particle file carries one). SubModelParts \
survive an export to .mdpa, .vtu, .med (as MED families), .inp (as *NSET/*ELSET) and — block names only — \
.exo; a .msh export carries no groups.
- kratos__* (kratos-mcp-server): the Kratos Multiphysics engine and its knowledge layer — \
single- and multi-stage project scaffolding, running simulations as background jobs, post-processing \
and probing results, introspecting process/solver defaults, material and linear-solver presets, \
explaining an existing ProjectParameters.json, and Flowgraph import/export (the same node-graph \
format KKSS's mesh mode edits).
- mcp__* (knowledge base): mcp__list_resources / mcp__read_resource surface worked examples and \
reference docs the servers ship; mcp__list_prompts / mcp__get_prompt fetch guided setup recipes. \
Consult these before scaffolding an unfamiliar analysis type.

Tools operate on files on disk; edits are written to sidecar files the app's viewers replay, so the \
user sees your changes when the file is (re)loaded. Always pass absolute paths. If a tool family is \
unavailable, say so and continue with what works. Be concise; lead with the outcome.`;

const MAX_ITERATIONS = 25;

export interface ChatDeps {
  /** Shared MCP manager owner (the three servers are spawned once, app-wide). */
  hub: McpHub;
  /** Currently open files, appended as context to each request. */
  currentFiles(): { cad?: string | null; mesh?: string | null };
  /** Pops the native Settings menu (noKey / auth error banner button). */
  openSettings(): void;
  /** Hide the sidebar (✕ button). */
  onHide(): void;
}

export class ChatService {
  private target: WebContents | null = null;
  private entries: ChatEntry[] = [];
  private busy = false;
  private abort: AbortController | null = null;
  private mcp: McpManager | null = null;

  constructor(private readonly deps: ChatDeps) {
    ipcMain.on("chat:toHost", (event, raw) => {
      if (!this.target || event.sender !== this.target) return;
      const msg = raw as ChatToHost;
      switch (msg.type) {
        case "chatReady":
          this.ensureStarted();
          this.sendState();
          break;
        case "send":
          void this.run(msg.text);
          break;
        case "stop":
          this.abort?.abort();
          break;
        case "newChat":
          this.abort?.abort();
          this.entries = [];
          this.sendState();
          break;
        case "openSettings":
          this.deps.openSettings();
          break;
        case "hide":
          this.deps.onHide();
          break;
      }
    });
    // The hub owns the servers' lifecycle (disposed in index.ts on will-quit);
    // we only mirror their status into the sidebar and abort the loop on quit.
    this.deps.hub.onStatus((servers) => this.send({ type: "servers", servers }));
    app.on("will-quit", () => this.abort?.abort());
  }

  /** Points the service at the sidebar view's WebContents (idempotent). */
  attach(target: WebContents): void {
    this.target = target;
  }

  /** Spawns the MCP servers on first use (chat open), not at app launch. */
  ensureStarted(): void {
    this.mcp = this.deps.hub.ensureStarted();
  }

  private send(message: ChatToWebview): void {
    if (this.target && !this.target.isDestroyed()) this.target.send("chat:toWebview", message);
  }

  private sendState(): void {
    const settings = readLlmSettings();
    this.send({
      type: "state",
      entries: this.entries.map(toWire),
      busy: this.busy,
      servers: this.deps.hub.statuses(),
      providerLabel: settings.provider === "anthropic" ? `Anthropic · ${settings.model}` : `${settings.baseUrl} · ${settings.model}`,
    });
  }

  private pushError(message: string, errorKind: ChatErrorKind): void {
    const entry: ChatEntry = { kind: "error", message, errorKind };
    this.entries.push(entry);
    this.send({ type: "entry", entry: toWire(entry) });
  }

  private makeProvider(settings: LlmSettings): Provider | null {
    if (settings.provider === "anthropic") {
      if (!settings.apiKey) return null; // Anthropic always needs a key
      return createAnthropicProvider(settings.apiKey);
    }
    // OpenAI-compatible backends may legitimately run keyless (e.g. Ollama).
    return createOpenAiCompatProvider({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
  }

  /** Volatile context appended to the newest user message, not the system
   *  prompt, so the cached prompt prefix stays byte-stable. */
  private contextSuffix(): string {
    const files = this.deps.currentFiles();
    const parts: string[] = [];
    if (files.cad) parts.push(`CAD (pre-processing): ${files.cad}`);
    if (files.mesh) parts.push(`Mesh (post-processing): ${files.mesh}`);
    if (!parts.length) return "";
    return `\n\n[Context — files currently open in KKSS: ${parts.join("; ")}]`;
  }

  async run(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) return;

    const settings = readLlmSettings();
    const provider = this.makeProvider(settings);
    if (!provider) {
      this.pushError("No Anthropic API key configured. Set it under Settings ▸ LLM Assistant.", "noKey");
      return;
    }

    this.ensureStarted();
    const mcp = this.mcp!;

    const userEntry: ChatEntry = { kind: "user", text: trimmed };
    this.entries.push(userEntry);
    this.send({ type: "entry", entry: toWire(userEntry) });
    this.busy = true;
    this.send({ type: "busy", busy: true });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    // The context suffix rides on a copy of the transcript so it never
    // accumulates in the stored history.
    const requestEntries = (): ChatEntry[] => {
      const copy = [...this.entries];
      for (let i = copy.length - 1; i >= 0; i--) {
        const entry = copy[i];
        if (entry.kind === "user") {
          copy[i] = { ...entry, text: entry.text + this.contextSuffix() };
          break;
        }
      }
      return copy;
    };

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        this.send({ type: "assistantStart" });
        const result = await provider.streamTurn({
          system: SYSTEM_PROMPT,
          entries: requestEntries(),
          tools: mcp.chatTools(),
          model: settings.model,
          signal,
          onTextDelta: (delta) => this.send({ type: "assistantDelta", text: delta }),
          toolName: mcp.toolName,
        });

        const assistantEntry: ChatEntry = { kind: "assistant", text: result.text };
        this.entries.push(assistantEntry);
        this.send({ type: "assistantDone", entry: toWire(assistantEntry) });

        if (!result.toolCalls.length) return;

        for (const call of result.toolCalls) {
          if (signal.aborted) return;
          const split = call.name.split("__");
          const callEntry: ChatEntry = {
            kind: "toolCall",
            callId: call.id,
            server: split[0] ?? "",
            tool: split.slice(1).join("__") || call.name,
            argsJson: call.argsJson,
          };
          this.entries.push(callEntry);
          this.send({ type: "entry", entry: toWire(callEntry) });

          const outcome = await mcp.callTool(call.name, call.argsJson);
          if (signal.aborted) return; // drop the result: the dangling call is pruned on the next request
          const resultEntry: ChatEntry = { kind: "toolResult", callId: call.id, ok: outcome.ok, text: outcome.text };
          this.entries.push(resultEntry);
          this.send({ type: "entry", entry: toWire(resultEntry) });
        }
      }
      this.pushError(`Stopped after ${MAX_ITERATIONS} tool iterations — ask me to continue if needed.`, "other");
    } catch (error) {
      if (signal.aborted) {
        // Mark the interrupted assistant turn so the transcript reads honestly.
        const last = this.entries[this.entries.length - 1];
        if (last?.kind === "assistant") last.stopped = true;
        else this.entries.push({ kind: "assistant", text: "", stopped: true });
        this.send({ type: "assistantDone", entry: toWire(this.entries[this.entries.length - 1]) });
      } else if (error instanceof ProviderError) {
        this.pushError(error.message, error.kind);
      } else {
        this.pushError(error instanceof Error ? error.message : String(error), "other");
      }
    } finally {
      this.abort = null;
      this.busy = false;
      this.send({ type: "busy", busy: false });
    }
  }

  /** Aborts any in-flight turn; the servers themselves are owned by the hub. */
  dispose(): void {
    this.abort?.abort();
  }
}
