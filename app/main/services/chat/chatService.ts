/**
 * Chat sidebar backend: owns the conversations and the agent loop (provider
 * turn → MCP tool calls → repeat), bridged to app/renderer/chat/ over
 * chat:toHost / chat:toWebview. All network and child-process work lives
 * here — the renderer keeps the strict CSP and never sees an API key.
 *
 * Same service conventions as terminal.ts/editor.ts: ipcMain handler with a
 * sender guard in the constructor, attach() to point at the sidebar view,
 * full-state replay on chatReady, dispose() on will-quit.
 *
 * Transcripts are durable (transcriptStore.ts) and there are many of them, so
 * one rule governs everything below: **a turn is bound to the conversation
 * that was active when run() started.** Every append targets that object and
 * every message is gated on it still being on screen — otherwise switching or
 * deleting a conversation mid-turn would file the model's next tool call under
 * whatever the user happened to open, and paint it there too. Switching or
 * deleting the *active* conversation therefore aborts the turn and waits for it
 * to unwind first; deleting a background one leaves it running.
 */
import { app, ipcMain, WebContents } from "electron";
import type {
  ChatConversationInfo,
  ChatErrorKind,
  ChatPendingApproval,
  ChatToHost,
  ChatToolApproval,
  ChatToWebview,
} from "../../ipc";
import {
  classifyTool,
  DEFAULT_APPROVAL_MODE,
  gateFor,
  isApprovalMode,
  unclassifiedTools,
  type ApprovalDecision,
  type ApprovalMode,
} from "./toolPolicy";
import { stateStore } from "../stateStore";
import { getSecret } from "./secrets";
import type { McpManager } from "./mcpManager";
import type { McpHub } from "./mcpHub";
import { ChatEntry, toWire } from "./transcript";
import { TranscriptStore } from "./transcriptStore";
import {
  appendEntry,
  deriveTitle,
  isEmptyConversation,
  markStopped,
  type LiveConversation,
} from "./transcriptStoreCore";
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
  toolApproval: "llmToolApproval", // ApprovalMode; see toolPolicy.ts
} as const;

export interface LlmSettings {
  provider: "anthropic" | "openai";
  model: string;
  baseUrl: string;
  apiKey?: string;
}

/**
 * Read per tool call rather than per turn, so flipping the setting mid-turn
 * applies to the very next call — the same "changes apply immediately, no
 * restart" contract every other LLM setting has.
 */
export function readApprovalMode(): ApprovalMode {
  const stored = stateStore.get<string>(LLM_KEYS.toolApproval, DEFAULT_APPROVAL_MODE);
  // A hand-edited state.json must degrade to the default, never to "never".
  return isApprovalMode(stored) ? stored : DEFAULT_APPROVAL_MODE;
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
OpenSCAD .csg (parsed and built kernel-side) and .scad (converted to .csg first by a user-installed \
openscad binary — without one every .scad call answers supported:false rather than failing), plus \
VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA imported through meshio++ as geometry-only boundary surfaces; apply \
parametric edit operations via sidecar files (including run_parametric_script for declarative, re-runnable \
part scripts), define FEM sub-model-parts, and generate and export meshes with Gmsh — with optional unit \
conversion (mm/cm/m/in/ft) on export, and MED/CGNS/XDMF mesh targets Gmsh's own writers cannot produce. \
It also answers questions about a model without changing it: get_mass_properties (volume, area, centre of \
mass, moments of inertia), inspect and measure (bounding-box facts), measure_exact (true OCCT distance, \
edge length, radius), check_interference (clash detection between solids or Parts), compare_models (a \
geometric diff of two models, optionally with rendered images), render_snapshot (headless multi-view PNGs), \
and search_standard_parts / download_standard_part (fasteners and other standard parts from step.parts, \
the one tool family that reaches the network). It also reads .foam OpenFOAM cases and .msh/.inp/.unv/.su2/\
.mesh/.post.msh, which KKSS opens in CAD mode only when post mode cannot read them. Beyond geometry it \
reports and repairs: recognize_primitives and fit_mesh_region name the analytic surface under a face or a \
grown mesh region (each with its own residual), check_mesh_health then promote_mesh_to_brep turns a clean \
skin mesh into a solid, repair_mesh makes a broken one watertight with fTetWild first, generate_bom and \
check_tolerance answer part-count and fit questions, hit_test resolves a ray to an entity without a browser, \
and export_svg_silhouette / export_technical_drawing produce 2D SVG or DXF (the latter with hidden-line \
removal). set_plane persists a named construction plane beside the model; save_parametric_script / \
list_parametric_scripts / run_saved_script are the macro library the viewer's Macros panel shares. \
resolve_selector and synthesize_selector persist a re-executable QUERY for an op operand instead of a \
positional entity id, so an edit keeps naming the right face after the op list is spliced — prefer them \
over a bare face-N whenever an op's operand has to survive later edits; a null query with a reason is an \
honest refusal, never a guess. The op catalog also carries rib and drill, extrude's upToFace terminator, \
region pick on extrude/revolve/sweep, and loft smoothing. Call \
cad__describe_capabilities before your first cad__apply_edit_ops to learn the operation catalog.
- mesh__* (kratos-mdpa): mesh inspection and transformation — info, quality metrics, and mesh size \
(nodal Kratos NODAL_H + element edge length with box-whisker stats, std, and IQR small/large outlier ids) for MDPA, \
VTK, STL/OBJ/PLY and 43 extended formats read through meshio++ (Gmsh .msh, Abaqus .inp, Nastran, UNV, Medit, \
Netgen, SU2, XDMF, Exodus .e/.exo/.ex2, CGNS, MOAB .h5m, Salome .med, tetgen, EnSight Gold, Triangle, GiD \
postprocess .post.msh/.post.res/.post.bin/.post.h5, OpenFOAM .foam on export, …), 37 of them writable, format conversion (pass inputFormat/outputFormat to force a meshio++ reader/writer when \
the extension is ambiguous; pass timeStep to pick a step of a multi-step file — Exodus and Salome MED, but \
only Exodus reports its available times as mesh__mesh_info's timeValues, so a MED step count is discoverable \
only by asking for one), boundary-skin extraction, and Kratos case setup \
(problemtypes, ProjectParameters, materials). mesh__mesh_transform applies an undoable op list: MMG remeshing \
(incl. mode "expr", a formula over the nodal size h, the whole-mesh size statistics and the coordinates, with \
optional per-SubModelPart overrides, and mode "aniso", which differentiates a scalar nodal field twice \
inline and adapts the mesh to the curvature of that solution — fine across a boundary layer, coarse along \
it, clamped by hmin/hmax; remeshing also takes "frozen" EntityBlocks/SubModelParts MMG must leave \
bit-identical and per-block/per-part "localSizes" hmin/hmax/hausd bounds, both remesh-only) \
and level-set splitting, smoothing, RCM/Morton/Hilbert renumbering, \
space-filling-curve partitioning, uniform refinement, linear↔quadratic conversion, simplexification, box/plane \
cropping, a field calculator and nodal↔elemental averaging, mesh merging (N files in one op), id renumbering, \
the five SubModelPart-tree ops (create/move/merge/add/remove entities), field gradient, Hessian, \
Zienkiewicz-Zhu error estimation, signed distance to an external surface, mass-preserving field transfer, \
and the RADIUS of SPHERE/particle elements (mesh__mesh_info's spheres section tells you whether a particle \
file carries one; its beams section does the same for CROSS_AREA-carrying line elements, and its \
constraints section for multi-point constraints, which every op now maintains rather than drops, and its \
isolatedNodes section for nodes no cell references). mesh__mesh_info also takes metadataOnly: true, which \
answers from the file header alone — available only for .xdmf/.xmf/.msh and the GiD .post.* set, and \
refused elsewhere rather than served at full-parse cost, so use it when you need counts/blocks/fields/time \
values for one of those and not the mesh itself. \
mesh_field_integrate gives cell-measure-weighted totals and means per region, mesh_export_table writes the \
whole entity table as CSV/XLSX, and mesh_field_series samples one entity across every step of a time \
series. case_run starts a solve detached (logging to <stem>.kratosrun.log), case_status reports on it from \
the <stem>.kratosrun.json sidecar the app's own run manager shares, and case_stop walks SIGINT → SIGTERM → \
SIGKILL. SubModelParts survive an export to .mdpa, .vtu, .med (as MED families), .inp (as *NSET/*ELSET) \
and — block names only — .exo; a .msh export carries no groups.
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

/** Shared empty set, so the common (no grants) path allocates nothing. */
const EMPTY_ALLOW_SET: ReadonlySet<string> = new Set<string>();

/**
 * What the model is told when the user refuses a call.
 *
 * Load-bearing prose, not a placeholder. Without the "do not retry" the model
 * reliably re-emits the same call, and every retry costs one of the 25
 * iterations a turn gets — so a few denials would end the turn in the generic
 * "stopped after 25 tool iterations" error instead of a useful answer.
 */
const DENIED_TEXT =
  "Denied by the user. The tool was NOT run and nothing on disk was changed. " +
  "Do not retry this call — explain what it would have done and ask the user what " +
  "they want instead, or use a read-only tool to gather more facts.";

/** Every open document per mode (KKSS supports several concurrent tabs), plus
 *  which one is currently focused — see the Context suffix's doc comment. */
export interface OpenFilesInfo {
  cad: string[];
  mesh: string[];
  activeCad?: string | null;
  activeMesh?: string | null;
  /** The project root the user is working in, when one is set. A default the
   *  assistant should prefer for new files — not a restriction. */
  projectRoot?: string;
  /**
   * Documents whose local path is a staging copy of a remote file, keyed by the
   * same absolute path that appears in `cad`/`mesh`. The MCP servers only ever
   * see the staging path, so no tool changes — but the assistant must not
   * assume such a path is stable the way a plain local one is.
   */
  cloud?: Record<string, { provider: string; name: string; folder?: string }>;
}

export interface ChatDeps {
  /** Shared MCP manager owner (the three servers are spawned once, app-wide). */
  hub: McpHub;
  /** Where conversations are persisted — <userData>/chats. Injected rather
   *  than read from `app` so the service is testable without Electron paths. */
  chatsDir: string;
  /** Currently open files, appended as context to each request. */
  currentFiles(): OpenFilesInfo;
  /** Pops the native Settings menu (noKey / auth error banner button). */
  openSettings(): void;
  /** Hide the sidebar (✕ button). */
  onHide(): void;
  /** Test seam: overrides the provider the settings would select. */
  provider?(settings: LlmSettings): Provider | null;
}

export class ChatService {
  private target: WebContents | null = null;
  private readonly store: TranscriptStore;
  /** The conversation on screen. Created or restored lazily — see ensureActive. */
  private active: LiveConversation | null = null;
  private busy = false;
  private abort: AbortController | null = null;
  /** The in-flight run(), so a switch can wait for its abort to unwind. */
  private turn: Promise<void> | null = null;
  /** Serializes new/select/delete against each other — two fast clicks must
   *  not interleave two switches. */
  private queue: Promise<void> = Promise.resolve();
  /** Assistant text streamed so far this turn, so an interruption can record
   *  what the user actually watched arrive. */
  private partial = "";
  private stoppedMarked = false;
  private mcp: McpManager | null = null;
  /**
   * The tool call blocked on the user, if any. At most one can be outstanding:
   * the tool loop is strictly sequential and `run()` is guarded by `busy`.
   * Keyed by callId so a stale click — from a replayed transcript, or a second
   * renderer — is a no-op rather than a mis-approval.
   */
  private pendingApproval: {
    pending: ChatPendingApproval;
    settle(decision: ApprovalDecision): void;
  } | null = null;
  /**
   * "Always allow this tool in this conversation", conversationId → tool names.
   * Never persisted — a grant that silently re-armed weeks later on a reopened
   * conversation would be a security regression, not a convenience.
   *
   * Deliberately NOT a field on `LiveConversation` (where `alive` is the
   * precedent for live-only state): `store.close()` drops that object on every
   * conversation switch, so a grant would expire on a round trip through the
   * history popover — which reads as the feature being broken.
   */
  private readonly alwaysAllow = new Map<string, Set<string>>();
  /** Unclassified tool names are logged once per process, not once per turn. */
  private loggedUnclassified = false;

  constructor(private readonly deps: ChatDeps) {
    this.store = new TranscriptStore(deps.chatsDir);
    ipcMain.on("chat:toHost", (event, raw) => {
      if (!this.target || event.sender !== this.target) return;
      const msg = raw as ChatToHost;
      switch (msg.type) {
        case "chatReady":
          this.ensureStarted();
          this.sendState();
          break;
        case "send":
          this.turn = this.run(msg.text).finally(() => {
            this.turn = null;
          });
          break;
        case "stop":
          this.abort?.abort();
          break;
        case "approveTool":
          // Correlated by callId, matching the rest of ChatToHost's
          // fire-and-forget shape. A mismatch means the decision arrived for a
          // call that is no longer waiting — ignore it rather than settling
          // whatever happens to be pending now.
          if (this.pendingApproval?.pending.callId === msg.callId) {
            this.pendingApproval.settle(msg.decision);
          }
          break;
        case "newChat":
          this.enqueue(() => this.startNew());
          break;
        case "listConversations":
          this.sendConversations();
          break;
        case "selectConversation":
          this.enqueue(() => this.select(msg.id));
          break;
        case "renameConversation":
          this.rename(msg.id, msg.title);
          break;
        case "deleteConversation":
          this.enqueue(() => this.remove(msg.id));
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

  // ---- conversations -------------------------------------------------------

  /** The conversation on screen: the one left open at the last quit, else the
   *  most recent, else a fresh one. Read on every path that needs a target. */
  private ensureActive(): LiveConversation {
    if (!this.active) this.active = this.store.restoreActive() ?? this.store.create();
    return this.active;
  }

  private conversationList(): ChatConversationInfo[] {
    return this.store.list().conversations.map(({ id, title, updatedAt, entryCount }) => ({
      id,
      title,
      updatedAt,
      entryCount,
    }));
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((err) => console.error("[chat]", err));
  }

  /** Aborts an in-flight turn and waits for it to unwind, so its stopped marker
   *  lands in the transcript the user is still looking at. */
  private async settleTurn(): Promise<void> {
    if (!this.busy) return;
    this.abort?.abort();
    await this.turn?.catch(() => undefined);
  }

  private async switchTo(next: LiveConversation): Promise<void> {
    await this.settleTurn();
    const prev = this.active;
    if (prev && prev !== next) await this.store.close(prev); // flush, then drop from memory
    this.active = next;
    this.store.setActive(next.id);
    this.sendState();
  }

  /** New Chat archives rather than destroys: the previous conversation is on
   *  disk and one click away in the history list, so there is nothing to
   *  confirm. An untouched one is reused instead of stacking up empties. */
  private async startNew(): Promise<void> {
    if (this.active && isEmptyConversation(this.active)) {
      this.sendState();
      return;
    }
    await this.switchTo(this.store.create());
  }

  private async select(id: string): Promise<void> {
    if (this.active?.id === id) {
      this.sendState();
      return;
    }
    await this.switchTo(this.store.load(id) ?? this.store.create());
  }

  private async remove(id: string): Promise<void> {
    if (this.active?.id !== id) {
      // Deleting a conversation the user is not looking at must not kill the
      // turn running in the one they are.
      this.store.remove(id);
      this.alwaysAllow.delete(id);
      this.sendConversations();
      return;
    }
    await this.settleTurn();
    // Belt to sendTo's braces: a late append from an unwinding turn would
    // otherwise recreate the file we are about to delete.
    this.active.alive = false;
    this.store.remove(id);
    this.alwaysAllow.delete(id);
    await this.switchTo(this.store.restoreActive() ?? this.store.create());
  }

  private rename(id: string, title: string): void {
    const clean = deriveTitle(title);
    this.store.rename(id, clean);
    if (this.active?.id === id) {
      this.active.title = clean;
      this.store.save(this.active);
      this.sendState();
    } else {
      this.sendConversations();
    }
  }

  // ---- messaging -----------------------------------------------------------

  private send(message: ChatToWebview): void {
    if (this.target && !this.target.isDestroyed()) this.target.send("chat:toWebview", message);
  }

  /** Every message a turn emits goes through here: a turn that outlived its
   *  conversation must never paint into whatever is on screen now. */
  private sendTo(convo: LiveConversation, message: ChatToWebview): void {
    if (convo !== this.active) return;
    this.send(message);
  }

  private sendState(): void {
    const settings = readLlmSettings();
    const convo = this.ensureActive();
    this.send({
      type: "state",
      entries: convo.entries.map(toWire),
      busy: this.busy,
      servers: this.deps.hub.statuses(),
      providerLabel: settings.provider === "anthropic" ? `Anthropic · ${settings.model}` : `${settings.baseUrl} · ${settings.model}`,
      conversationId: convo.id,
      conversationTitle: convo.title,
      conversations: this.conversationList(),
      // Replayed here and nowhere else: the renderer rebuilds the transcript
      // wholesale from this message, so without it a reload (or a switch away
      // and back) would leave a blocked turn with no prompt to answer it.
      pendingApproval: this.pendingApproval?.pending,
    });
  }

  private sendConversations(): void {
    this.send({ type: "conversations", conversations: this.conversationList(), activeId: this.ensureActive().id });
  }

  /** Every append a turn makes goes through here. */
  /**
   * Blocks until the user decides — or until the turn is aborted.
   *
   * **Never rejects, and always settles.** `settleTurn()` *awaits* the running
   * turn, and five paths reach it: Stop, New chat, selecting another
   * conversation, deleting the active one, and `will-quit`. A promise that
   * could stay pending would deadlock every one of them, so the abort listener
   * here is not a nicety — it is what keeps the app closable.
   *
   * `sendTo` drops the request if the user has switched conversations, which is
   * correct for painting and harmless for liveness: the switch aborted the turn
   * first, so the promise is already settled by the time that matters.
   */
  private awaitApproval(
    convo: LiveConversation,
    pending: ChatPendingApproval,
    signal: AbortSignal
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      let done = false;
      const finish = (decision: ApprovalDecision): void => {
        if (done) return; // a click that lands after the abort is a no-op
        done = true;
        signal.removeEventListener("abort", onAbort);
        if (this.pendingApproval?.pending.callId === pending.callId) this.pendingApproval = null;
        resolve(decision);
      };
      const onAbort = () => finish("deny");
      if (signal.aborted) return finish("deny");
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApproval = { pending, settle: finish };
      this.sendTo(convo, { type: "approvalRequest", pending });
    });
  }

  /**
   * Annotates a toolCall entry that has already been appended and painted.
   *
   * The one sanctioned exception to `append()` being the only mutation point:
   * the decision does not exist until after the user has seen the entry. Safe
   * because `webContents.send` structured-clones synchronously, so the copy the
   * renderer already holds is untouched — which is why the decision is also
   * pushed explicitly as `approvalResolved`.
   */
  private setApproval(convo: LiveConversation, entry: ChatEntry, approval: ChatToolApproval): void {
    if (entry.kind !== "toolCall") return;
    entry.approval = approval;
    this.store.saveSoon(convo);
    this.sendTo(convo, { type: "approvalResolved", callId: entry.callId, approval });
  }

  private rememberAlways(convo: LiveConversation, namespaced: string): void {
    const set = this.alwaysAllow.get(convo.id) ?? new Set<string>();
    set.add(namespaced);
    this.alwaysAllow.set(convo.id, set);
  }

  /** Names the advertised tools toolPolicy.ts has no row for, once per process.
   *  An unclassified tool is safe (it asks), but a tree of them degrades into
   *  "ask about everything" — this is the seam a submodule or
   *  KRATOS_MCP_VERSION bump is noticed through. */
  private reportUnclassified(tools: readonly { name: string }[]): void {
    if (this.loggedUnclassified) return;
    this.loggedUnclassified = true;
    const unknown = unclassifiedTools(tools);
    if (unknown.length) {
      console.log(`[chat] tools with no toolPolicy.ts row (they will always ask): ${unknown.join(", ")}`);
    }
  }

  private append(convo: LiveConversation, entry: ChatEntry): void {
    if (!convo.alive) return; // the conversation was deleted mid-turn
    appendEntry(convo, entry, Date.now());
    this.store.saveSoon(convo);
    this.sendTo(convo, { type: "entry", entry: toWire(entry) });
  }

  private pushError(convo: LiveConversation, message: string, errorKind: ChatErrorKind): void {
    this.append(convo, { kind: "error", message, errorKind });
  }

  private makeProvider(settings: LlmSettings): Provider | null {
    if (this.deps.provider) return this.deps.provider(settings);
    if (settings.provider === "anthropic") {
      if (!settings.apiKey) return null; // Anthropic always needs a key
      return createAnthropicProvider(settings.apiKey);
    }
    // OpenAI-compatible backends may legitimately run keyless (e.g. Ollama).
    return createOpenAiCompatProvider({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
  }

  /** Volatile context appended to the newest user message, not the system
   *  prompt, so the cached prompt prefix stays byte-stable. Each mode can have
   *  several open tabs — every path is listed, with the focused one marked,
   *  so the model doesn't guess which document a bare "the file" refers to.
   *  The project root leads when one is set: it is where the user is working,
   *  so it is the sensible default for a file the assistant creates. It is a
   *  default and not a boundary — nothing refuses a path outside it.
   *
   *  A cloud-backed document is marked here rather than in the system prompt:
   *  it is context the assistant reads, not an ability it can invoke (there is
   *  no cloud tool), and the prompt has to stay byte-stable. */
  private contextSuffix(): string {
    const files = this.deps.currentFiles();
    const describe = (label: string, paths: string[], active?: string | null) => {
      if (!paths.length) return undefined;
      const list = paths
        .map((p) => {
          const origin = files.cloud?.[p];
          const marks = [
            p === active ? "focused" : undefined,
            origin ? `${origin.provider} staging copy` : undefined,
          ].filter((m): m is string => !!m);
          return marks.length ? `${p} (${marks.join(", ")})` : p;
        })
        .join(", ");
      return `${label}: ${list}`;
    };
    const parts = [
      files.projectRoot ? `Project root: ${files.projectRoot}` : undefined,
      describe("CAD (pre-processing) tabs", files.cad, files.activeCad),
      describe("Mesh (post-processing) tabs", files.mesh, files.activeMesh),
    ].filter((p): p is string => !!p);
    if (files.cloud && Object.keys(files.cloud).length > 0) {
      parts.push(
        "a staging copy lives in a local cache — the path is valid for this session " +
          "but not stable across sessions, so read it from this context each turn " +
          "rather than remembering it"
      );
    }
    if (!parts.length) return "";
    return `\n\n[Context — KKSS workspace: ${parts.join("; ")}]`;
  }

  /** Records an interrupted turn once, whether the interruption was Stop, a
   *  conversation switch, or the app quitting under it. */
  private markInterrupted(convo: LiveConversation): ChatEntry | undefined {
    if (this.stoppedMarked || !convo.alive) return undefined;
    this.stoppedMarked = true;
    const entry = markStopped(convo, this.partial, Date.now());
    this.store.save(convo);
    return entry;
  }

  async run(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) return;

    // Bound once, here: everything below appends to and paints into this
    // conversation, even if the user moves to another one mid-turn.
    const convo = this.ensureActive();

    // Recorded before the provider is resolved: the composer has already
    // cleared, so a message dropped here (no API key) would simply vanish —
    // and would leave a stored conversation holding nothing but an error.
    this.append(convo, { kind: "user", text: trimmed });
    // Undebounced: a user message is a checkpoint worth keeping even if the
    // turn never comes back, and it is what puts a brand-new conversation into
    // the history list — the first one also names it.
    this.store.save(convo);
    this.sendConversations();

    const settings = readLlmSettings();
    const provider = this.makeProvider(settings);
    if (!provider) {
      this.pushError(convo, "No Anthropic API key configured. Set it under Settings ▸ LLM Assistant.", "noKey");
      return;
    }

    this.ensureStarted();
    const mcp = this.mcp!;
    this.reportUnclassified(mcp.chatTools());
    this.busy = true;
    this.partial = "";
    this.stoppedMarked = false;
    this.sendTo(convo, { type: "busy", busy: true });
    this.abort = new AbortController();
    const signal = this.abort.signal;

    // The context suffix rides on a copy of the transcript so it never
    // accumulates in the stored history.
    const requestEntries = (): ChatEntry[] => {
      const copy = [...convo.entries];
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
        this.sendTo(convo, { type: "assistantStart" });
        const result = await provider.streamTurn({
          system: SYSTEM_PROMPT,
          entries: requestEntries(),
          tools: mcp.chatTools(),
          model: settings.model,
          signal,
          onTextDelta: (delta) => {
            this.partial += delta;
            this.sendTo(convo, { type: "assistantDelta", text: delta });
          },
          toolName: mcp.toolName,
        });

        const assistantEntry: ChatEntry = { kind: "assistant", text: result.text };
        this.append(convo, assistantEntry);
        this.partial = "";
        this.sendTo(convo, { type: "assistantDone", entry: toWire(assistantEntry) });

        if (!result.toolCalls.length) return;

        for (const call of result.toolCalls) {
          if (signal.aborted) return;
          const split = call.name.split("__");
          const server = split[0] ?? "";
          const tool = split.slice(1).join("__") || call.name;
          // Appended BEFORE the gate: the user has to be able to read the
          // arguments in the very chip they are being asked to approve.
          const entry: ChatEntry = {
            kind: "toolCall",
            callId: call.id,
            server,
            tool,
            argsJson: call.argsJson,
          };
          this.append(convo, entry);

          const allowed = this.alwaysAllow.get(convo.id) ?? EMPTY_ALLOW_SET;
          if (gateFor(call.name, { mode: readApprovalMode(), allowed }) === "ask") {
            const access = classifyTool(call.name) === "write" ? "write" : "unknown";
            const decision = await this.awaitApproval(
              convo,
              { callId: call.id, server, tool, argsJson: call.argsJson, access },
              signal
            );
            if (signal.aborted) return; // aborted rather than decided — drop it, as an aborted call always was
            if (decision === "deny") {
              this.setApproval(convo, entry, "denied");
              // A denial MUST still produce a result: transcript.ts drops a
              // tool call with no matching result, so a silent denial would
              // vanish from the next request and the model would re-emit the
              // same call, burning one of MAX_ITERATIONS.
              this.append(convo, { kind: "toolResult", callId: call.id, ok: false, text: DENIED_TEXT });
              continue; // each call in a batch is gated on its own
            }
            if (decision === "allowAlways") this.rememberAlways(convo, call.name);
            this.setApproval(convo, entry, "allowed");
          }

          const outcome = await mcp.callTool(call.name, call.argsJson);
          if (signal.aborted) return; // drop the result: the dangling call is pruned on the next request
          this.append(convo, { kind: "toolResult", callId: call.id, ok: outcome.ok, text: outcome.text });
        }
      }
      this.pushError(convo, `Stopped after ${MAX_ITERATIONS} tool iterations — ask me to continue if needed.`, "other");
    } catch (error) {
      if (signal.aborted) {
        const entry = this.markInterrupted(convo);
        if (entry) this.sendTo(convo, { type: "assistantDone", entry: toWire(entry) });
      } else if (error instanceof ProviderError) {
        this.pushError(convo, error.message, error.kind);
      } else {
        this.pushError(convo, error instanceof Error ? error.message : String(error), "other");
      }
    } finally {
      this.abort = null;
      this.busy = false;
      this.sendTo(convo, { type: "busy", busy: false });
      // Undebounced: a finished turn is durable within a tick, not a second.
      this.store.save(convo);
      this.sendConversations();
    }
  }

  /**
   * Last-chance synchronous persist for will-quit, which cannot await. The
   * stopped marker has to be applied here rather than on the abort path: the
   * store is latched shut by flushSync(), so anything the unwinding turn writes
   * afterwards would never reach disk.
   */
  flushSync(): void {
    // Before anything else: the store latches shut below, and settleTurn's
    // usual abort path may not have run yet. An unsettled approval would leave
    // run() suspended with nothing left that can resume it.
    this.pendingApproval?.settle("deny");
    if (this.busy && this.active) this.markInterrupted(this.active);
    this.store.flushSync();
  }

  /** Aborts any in-flight turn; the servers themselves are owned by the hub. */
  dispose(): void {
    this.abort?.abort();
  }
}
