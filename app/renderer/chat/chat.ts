/**
 * Chat sidebar renderer: message list with streaming assistant text,
 * expandable tool-call chips, MCP server status dots, and the composer.
 * Model output is rendered with a tiny markdown-lite formatter built purely
 * from createElement/textContent — no innerHTML of untrusted text, so the
 * page keeps the strict CSP.
 */
import type {
  ChatConversationInfo,
  ChatUsage,
  ChatImage,
  ChatPendingApproval,
  ChatServerStatus,
  ChatToHost,
  ChatToWebview,
  ChatWireEntry,
} from "../../main/ipc";

declare global {
  interface Window {
    chatApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.chatApi;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const messages = byId<HTMLDivElement>("messages");
const serversEl = byId<HTMLSpanElement>("servers");
const titleEl = byId<HTMLSpanElement>("chat-title");
const input = byId<HTMLTextAreaElement>("input");
const sendBtn = byId<HTMLButtonElement>("send-btn");
const historyEl = byId<HTMLDivElement>("history");
const historyBtn = byId<HTMLButtonElement>("history-btn");
const newBtn = byId<HTMLButtonElement>("new-btn");
const hideBtn = byId<HTMLButtonElement>("hide-btn");
const usageEl = byId<HTMLSpanElement>("usage");
const compactionEl = byId<HTMLDivElement>("compaction");

let busy = false;
/** The assistant bubble currently receiving stream deltas. */
let streaming: { el: HTMLDivElement; text: string } | null = null;
/** callId of the approval prompt currently awaiting a click, if any. */
let armedApproval: string | null = null;
/** Last history list received, so the popover can repaint without a round trip. */
let conversations: ChatConversationInfo[] = [];
let activeId = "";

function post(message: ChatToHost): void {
  api.post(message);
}

function scrolledToBottom(): boolean {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
}

function scrollDown(force = false): void {
  if (force || scrolledToBottom()) messages.scrollTop = messages.scrollHeight;
}

// ---- markdown-lite (paragraphs, fenced code, `code`, **bold**) -------------

function renderInline(target: HTMLElement, text: string): void {
  // Split on `code` spans and **bold** runs; everything else is plain text.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) target.appendChild(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      target.appendChild(code);
    } else {
      const bold = document.createElement("strong");
      bold.textContent = token.slice(2, -2);
      target.appendChild(bold);
    }
    last = match.index! + token.length;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

/** Splits fenced code blocks first, then formats the plain parts. */
function renderRich(target: HTMLElement, text: string): void {
  target.textContent = "";
  const parts = text.split("```");
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // plain text segment
      for (const paragraph of parts[i].split(/\n{2,}/)) {
        if (!paragraph.trim()) continue;
        const p = document.createElement("p");
        const lines = paragraph.split("\n");
        lines.forEach((line, index) => {
          renderInline(p, line);
          if (index < lines.length - 1) p.appendChild(document.createElement("br"));
        });
        target.appendChild(p);
      }
    } else {
      // fenced code segment; first line may be the language tag
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = parts[i].replace(/^[^\n]*\n/, "").replace(/\n$/, "");
      pre.appendChild(code);
      target.appendChild(pre);
    }
  }
}

// ---- element builders ------------------------------------------------------

function addUser(text: string): void {
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  messages.appendChild(el);
  scrollDown(true);
}

function addAssistant(text: string, stopped?: boolean): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "msg assistant";
  renderRich(el, text);
  if (stopped) {
    const note = document.createElement("div");
    note.className = "stopped";
    note.textContent = "(stopped)";
    el.appendChild(note);
  }
  messages.appendChild(el);
  scrollDown();
  return el;
}

function addToolChip(entry: Extract<ChatWireEntry, { kind: "toolCall" }>): void {
  const details = document.createElement("details");
  details.className = "tool";
  details.dataset.callId = entry.callId;

  const summary = document.createElement("summary");
  const status = document.createElement("span");
  status.className = "tool-status running";
  status.textContent = "◌";
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = `${entry.server}__${entry.tool}`;
  summary.appendChild(status);
  summary.appendChild(name);
  details.appendChild(summary);

  const argsPre = document.createElement("pre");
  argsPre.textContent = prettyJson(entry.argsJson);
  details.appendChild(argsPre);

  // Replay of a call that was already decided: one dim line, no buttons. A
  // denied call must read as denied rather than as a tool that failed, or the
  // transcript looks like the app broke.
  if (entry.approval) {
    if (entry.approval === "denied") setToolStatus(details, "denied", "⊘");
    details.appendChild(decidedRow(entry.approval === "denied" ? "Denied by you." : "Approved by you."));
  }

  messages.appendChild(details);
  scrollDown();
}

function setToolStatus(chip: HTMLDetailsElement, cls: string, glyph: string): void {
  const status = chip.querySelector<HTMLSpanElement>(".tool-status");
  if (!status) return;
  status.classList.remove("running", "ask");
  status.classList.add(cls);
  status.textContent = glyph;
}

function decidedRow(text: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "tool-approval decided";
  row.textContent = text;
  return row;
}

function chipFor(callId: string): HTMLDetailsElement | undefined {
  // Last match: a callId can repeat across a state replay.
  const chips = messages.querySelectorAll<HTMLDetailsElement>(`details.tool[data-call-id="${CSS.escape(callId)}"]`);
  return chips[chips.length - 1];
}

/**
 * Images from a tool result, attached to its chip.
 *
 * The <img> elements are created only when the chip is actually open. A byte
 * cap bounds the transfer, not the decoded bitmap, so decoding eight snapshots
 * for every chip in a replayed transcript is exactly what must not happen —
 * `open` is forced for a live result the user should see, never on replay.
 */
function attachImages(callId: string, images: ChatImage[], live: boolean): void {
  const chip = chipFor(callId);
  if (!chip || !images.length) return;
  const paint = () => {
    if (chip.dataset.imagesPainted) return;
    chip.dataset.imagesPainted = "1";
    images.forEach((image, index) => {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      // Assigned on a created element, never interpolated into markup: the data
      // comes from an MCP server and the page has no 'unsafe-inline'.
      img.src = `data:${image.mimeType};base64,${image.dataBase64}`;
      // cad labels its views in the result's JSON text, not in the image block,
      // so the index is all that can honestly be claimed here.
      img.alt = `Tool result image ${index + 1} of ${images.length}`;
      img.title = `${image.mimeType} (${index + 1}/${images.length})`;
      chip.appendChild(img);
    });
    scrollDown();
  };
  if (live) chip.open = true;
  if (chip.open) paint();
  else chip.addEventListener("toggle", () => chip.open && paint());
}

/**
 * The approve/deny prompt, appended into the tool chip it belongs to.
 *
 * Built the same way as the error banner's Open Settings button —
 * createElement + addEventListener — because this page keeps a strict CSP with
 * no 'unsafe-inline'.
 */
function showApproval(pending: ChatPendingApproval): void {
  const chip = chipFor(pending.callId);
  if (!chip) return;
  // The one moment the arguments must actually be read: approving something
  // you cannot see is not approval.
  chip.open = true;
  setToolStatus(chip, "ask", "?");

  const row = document.createElement("div");
  row.className = "tool-approval";

  const msg = document.createElement("div");
  msg.className = "approval-msg";
  msg.textContent =
    pending.access === "write"
      ? "This tool can create, overwrite or delete files. Run it?"
      : "KKSS has no policy for this tool, so it is treated as unsafe. Run it?";
  row.appendChild(msg);

  // Not a fourth decision: it re-runs the call in validate-only mode and leaves
  // the prompt armed, so the user answers it with the report in front of them.
  if (pending.dryRunnable) {
    const dry = document.createElement("button");
    dry.className = "dryrun";
    dry.textContent = "Validate (dry run)";
    dry.addEventListener("click", () => {
      dry.disabled = true;
      dry.textContent = "Validating…";
      post({ type: "dryRunTool", callId: pending.callId });
    });
    row.appendChild(dry);
  }

  const choices: Array<[string, "allow" | "allowAlways" | "deny", string]> = [
    ["Allow", "allow", "allow"],
    ["Always allow in this chat", "allowAlways", "always"],
    ["Deny", "deny", "deny"],
  ];
  for (const [label, decision, cls] of choices) {
    const button = document.createElement("button");
    button.className = cls;
    button.textContent = label;
    button.addEventListener("click", () => {
      post({ type: "approveTool", callId: pending.callId, decision });
      // Optimistic: the click is what caused it. `approvalResolved` and
      // `busy:false` both re-sync if a message is ever lost.
      settleApproval(
        pending.callId,
        decision === "deny" ? "Denied." : "Allowed — running…"
      );
    });
    row.appendChild(button);
  }

  chip.appendChild(row);
  // A validation already run for this call, replayed with the prompt: a
  // renderer reload must not silently discard the answer it is looking at.
  if (pending.dryRunPreview) showDryRunResult(pending.callId, pending.dryRunPreview);
  armedApproval = pending.callId;
  scrollDown(true);
}

/**
 * The validation report, painted into the still-open prompt.
 *
 * Worded narrowly on purpose: cad gates its OCCT replay on the same flag it
 * gates its writes on, so this says which operations parse and are legal — not
 * what the geometry would become.
 */
function showDryRunResult(callId: string, result: { ok: boolean; text: string }): void {
  const chip = chipFor(callId);
  const row = chip?.querySelector<HTMLDivElement>(".tool-approval:not(.decided)");
  if (!chip || !row) return;
  row.querySelector<HTMLButtonElement>("button.dryrun")?.remove();
  chip.querySelector(".dry-run-report")?.remove();

  const block = document.createElement("div");
  block.className = "dry-run-report";
  const heading = document.createElement("div");
  heading.className = "dry-run-heading";
  heading.textContent = result.ok
    ? "Validated without running — nothing was executed or written."
    : "Validation failed — nothing was executed or written.";
  const body = document.createElement("pre");
  body.textContent = result.text;
  block.appendChild(heading);
  block.appendChild(body);
  row.insertAdjacentElement("beforebegin", block);
  scrollDown(true);
}

/** Replaces a still-armed prompt with a dim one-liner. */
function settleApproval(callId: string, label: string): void {
  const chip = chipFor(callId);
  const row = chip?.querySelector<HTMLDivElement>(".tool-approval:not(.decided)");
  if (row) row.replaceWith(decidedRow(label));
  if (armedApproval === callId) armedApproval = null;
}

function resolveToolChip(entry: Extract<ChatWireEntry, { kind: "toolResult" }>): void {
  const chips = messages.querySelectorAll<HTMLDetailsElement>(`details.tool[data-call-id="${CSS.escape(entry.callId)}"]`);
  const chip = chips[chips.length - 1];
  if (!chip) return;
  // A result means the decision is behind us; a row left armed here would be
  // clickable with nothing listening.
  chip.querySelector(".tool-approval:not(.decided)")?.remove();
  const status = chip.querySelector<HTMLSpanElement>(".tool-status");
  if (status) {
    status.classList.remove("running", "ask");
    status.classList.add(entry.ok ? "ok" : "err");
    status.textContent = entry.ok ? "✓" : "✗";
  }
  const resultPre = document.createElement("pre");
  resultPre.textContent = entry.preview;
  chip.appendChild(resultPre);
  scrollDown();
}

function addError(entry: Extract<ChatWireEntry, { kind: "error" }>): void {
  const el = document.createElement("div");
  el.className = "error-banner";
  el.textContent = entry.message;
  // These two used to arrive as "other" and render as a bare wall of provider
  // text. Both have an action the user can actually take right now.
  const advice =
    entry.errorKind === "context"
      ? "Start a new conversation (⟳ New) to continue — this one is too long to send."
      : entry.errorKind === "rateLimit"
        ? "The provider is throttling requests. Wait a moment and send again."
        : "";
  if (advice) {
    const line = document.createElement("div");
    line.className = "error-advice";
    line.textContent = advice;
    el.appendChild(line);
  }
  if (entry.errorKind === "auth" || entry.errorKind === "noKey") {
    const button = document.createElement("button");
    button.textContent = "Open Settings…";
    button.addEventListener("click", () => post({ type: "openSettings" }));
    el.appendChild(button);
  }
  messages.appendChild(el);
  scrollDown(true);
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function addEntry(entry: ChatWireEntry): void {
  switch (entry.kind) {
    case "user":
      addUser(entry.text);
      break;
    case "assistant":
      addAssistant(entry.text, entry.stopped);
      break;
    case "toolCall":
      addToolChip(entry);
      break;
    case "toolResult":
      resolveToolChip(entry);
      break;
    case "error":
      addError(entry);
      break;
  }
}

// ---- history popover ---------------------------------------------------------

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600e3],
  ["month", 30 * 24 * 3600e3],
  ["day", 24 * 3600e3],
  ["hour", 3600e3],
  ["minute", 60e3],
];

/** Timestamps arrive as epoch ms and are formatted here, so a popover left
 *  open does not slowly become a lie. */
function relativeTime(updatedAt: number): string {
  const delta = updatedAt - Date.now();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return relative.format(Math.round(delta / ms), unit);
  }
  return "just now";
}

/** Swaps the title for an input in place; Enter commits, Escape/blur cancels. */
function startRename(convo: ChatConversationInfo, titleSpan: HTMLSpanElement): void {
  const field = document.createElement("input");
  field.className = "convo-rename";
  field.value = convo.title;
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    field.replaceWith(titleSpan);
    const next = field.value.trim();
    if (commit && next && next !== convo.title) post({ type: "renameConversation", id: convo.id, title: next });
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      // Otherwise the document-level handler would also close the popover.
      event.stopPropagation();
      finish(false);
    }
  });
  field.addEventListener("blur", () => finish(false));
  titleSpan.replaceWith(field);
  field.focus();
  field.select();
}

function conversationRow(convo: ChatConversationInfo): HTMLDivElement {
  const row = document.createElement("div");
  row.className = convo.id === activeId ? "convo-row active" : "convo-row";

  const open = document.createElement("button");
  open.className = "convo-open";
  open.title = convo.title;
  const title = document.createElement("span");
  title.className = "convo-title";
  title.textContent = convo.title;
  const when = document.createElement("span");
  when.className = "convo-time";
  when.textContent = relativeTime(convo.updatedAt);
  open.appendChild(title);
  open.appendChild(when);
  open.addEventListener("click", () => {
    historyEl.hidden = true;
    if (convo.id !== activeId) post({ type: "selectConversation", id: convo.id });
  });

  const rename = document.createElement("button");
  rename.className = "convo-act";
  rename.textContent = "✎";
  rename.title = "Rename";
  rename.addEventListener("click", () => startRename(convo, title));

  // Two-click armed rather than a modal: this renderer has no dialog, and
  // deleting a conversation is the only irreversible thing in the sidebar.
  const del = document.createElement("button");
  del.className = "convo-act";
  del.textContent = "🗑";
  del.title = "Delete";
  del.addEventListener("click", () => {
    if (del.classList.contains("armed")) {
      post({ type: "deleteConversation", id: convo.id });
      return;
    }
    disarmAll();
    del.classList.add("armed");
    del.textContent = "Delete?";
  });

  row.appendChild(open);
  row.appendChild(rename);
  row.appendChild(del);
  return row;
}

function disarmAll(): void {
  for (const armed of historyEl.querySelectorAll<HTMLButtonElement>("button.convo-act.armed")) {
    armed.classList.remove("armed");
    armed.textContent = "🗑";
  }
}

function renderConversations(list: ChatConversationInfo[], active: string): void {
  conversations = list;
  activeId = active;
  historyEl.textContent = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "convo-empty";
    empty.textContent = "No saved conversations yet.";
    historyEl.appendChild(empty);
    return;
  }
  for (const convo of list) historyEl.appendChild(conversationRow(convo));
}

// ---- server dots -----------------------------------------------------------

function renderServers(servers: ChatServerStatus[]): void {
  serversEl.textContent = "";
  for (const server of servers) {
    const dot = document.createElement("span");
    dot.className = `server-dot ${server.state}`;
    const detail =
      server.state === "ready"
        ? `${server.toolCount ?? 0} tools`
        : server.state === "starting"
          ? "starting…"
          : `unavailable — ${server.error ?? "unknown error"}`;
    dot.title = `${server.name}: ${detail}`;
    serversEl.appendChild(dot);
  }
}

/** 12400 -> "12.4k", 900000 -> "900k", 1000000 -> "1M". Compact enough for the
 *  header strip, keeping a decimal only where it still carries information. */
function compactTokens(value: number): string {
  const trim = (text: string) => text.replace(/\.0$/, "");
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${trim((value / 1000).toFixed(value < 100_000 ? 1 : 0))}k`;
  return `${trim((value / 1_000_000).toFixed(1))}M`;
}

/**
 * Tokens, context fullness and cost, next to the server dots.
 *
 * Everything past the token count is conditional on the main process having
 * recognised the model: an unknown one (any Ollama/OpenRouter id) shows counts
 * alone rather than a fabricated price or percentage.
 */
function renderUsage(usage: ChatUsage | undefined): void {
  if (!usage) {
    usageEl.hidden = true;
    return;
  }
  usageEl.hidden = false;
  const parts = [
    usage.contextWindow ? `${compactTokens(usage.lastInput)}/${compactTokens(usage.contextWindow)}` : compactTokens(usage.lastInput),
  ];
  if (usage.costUsd !== undefined) parts.push(usage.costUsd < 0.01 ? "<$0.01" : `$${usage.costUsd.toFixed(2)}`);
  usageEl.textContent = parts.join(" · ");

  const share = usage.contextWindow ? usage.lastInput / usage.contextWindow : 0;
  usageEl.classList.toggle("near-limit", share >= 0.8);

  const detail = [
    `Model: ${usage.model}`,
    `Last request: ${usage.lastInput.toLocaleString()} input tokens${usage.contextWindow ? ` of ${usage.contextWindow.toLocaleString()}` : ""}`,
    `This conversation: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`,
    `Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} written`,
  ];
  if (usage.costUsd === undefined) detail.push("No pricing on record for this model — token counts only.");
  usageEl.title = detail.join("\n");
}

/**
 * Says that older tool results are no longer being sent to the model.
 *
 * Worth stating plainly because the transcript above is *not* compacted — every
 * result is still shown here in full. Without this line the model would simply
 * appear to have forgotten things the user can still see.
 */
function renderCompaction(count: number | undefined): void {
  if (!count) {
    compactionEl.hidden = true;
    return;
  }
  compactionEl.hidden = false;
  compactionEl.textContent =
    count === 1
      ? "1 older tool result is no longer sent to the model, to fit the context window."
      : `${count} older tool results are no longer sent to the model, to fit the context window.`;
  compactionEl.title = "The transcript still shows them in full. The assistant can re-run a tool if it needs the result again.";
}

// ---- busy / composer state ---------------------------------------------------

function setBusy(value: boolean): void {
  busy = value;
  sendBtn.textContent = busy ? "Stop" : "Send";
  sendBtn.classList.toggle("stop", busy);
  // The turn ended with a prompt still open — Stop, a conversation switch, a
  // delete or a quit. One line here covers every one of them without the
  // renderer needing to know which happened.
  if (!busy && armedApproval) settleApproval(armedApproval, "Cancelled.");
}

function submit(): void {
  if (busy) {
    post({ type: "stop" });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  post({ type: "send", text });
}

sendBtn.addEventListener("click", submit);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});
historyBtn.addEventListener("click", () => {
  historyEl.hidden = !historyEl.hidden;
  // Re-list on open so the relative times (and any eviction) are current.
  if (!historyEl.hidden) post({ type: "listConversations" });
});
newBtn.addEventListener("click", () => {
  historyEl.hidden = true;
  post({ type: "newChat" });
});
hideBtn.addEventListener("click", () => post({ type: "hide" }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !historyEl.hidden) historyEl.hidden = true;
});

// ---- host messages -----------------------------------------------------------

api.onMessage((raw) => {
  const msg = raw as ChatToWebview;
  switch (msg.type) {
    case "state":
      messages.textContent = "";
      streaming = null;
      armedApproval = null;
      // The tooltip stays the provider label; the visible name is the
      // conversation, which is what tells two of them apart.
      titleEl.title = msg.providerLabel;
      titleEl.textContent = msg.conversationTitle || "AI Chat";
      renderConversations(msg.conversations, msg.conversationId);
      msg.entries.forEach(addEntry);
      // After the entries, so the chip it attaches to exists. This is what
      // makes a renderer reload resume a blocked turn instead of stranding it.
      if (msg.pendingApproval) showApproval(msg.pendingApproval);
      renderUsage(msg.usage);
      renderCompaction(msg.compactedResults);
      renderServers(msg.servers);
      setBusy(msg.busy);
      scrollDown(true);
      break;
    case "approvalRequest":
      showApproval(msg.pending);
      break;
    case "toolImages":
      attachImages(msg.callId, msg.images, msg.live);
      break;
    case "usage":
      renderUsage(msg.usage);
      break;
    case "compaction":
      renderCompaction(msg.count);
      break;
    case "dryRunResult":
      showDryRunResult(msg.callId, { ok: msg.ok, text: msg.text });
      break;
    case "approvalResolved":
      // Normally the click already settled the row; this covers a decision
      // made elsewhere, and marks a denied call as denied rather than failed.
      if (msg.approval === "denied") {
        const chip = chipFor(msg.callId);
        if (chip) setToolStatus(chip, "denied", "⊘");
      }
      settleApproval(msg.callId, msg.approval === "denied" ? "Denied." : "Allowed — running…");
      break;
    case "conversations": {
      renderConversations(msg.conversations, msg.activeId);
      const active = conversations.find((c) => c.id === activeId);
      if (active) titleEl.textContent = active.title;
      break;
    }
    case "entry":
      addEntry(msg.entry);
      break;
    case "assistantStart":
      streaming = { el: addAssistant(""), text: "" };
      break;
    case "assistantDelta":
      if (!streaming) streaming = { el: addAssistant(""), text: "" };
      streaming.text += msg.text;
      renderRich(streaming.el, streaming.text);
      scrollDown();
      break;
    case "assistantDone":
      if (streaming && msg.entry.kind === "assistant") {
        renderRich(streaming.el, msg.entry.text);
        if (msg.entry.stopped) {
          const note = document.createElement("div");
          note.className = "stopped";
          note.textContent = "(stopped)";
          streaming.el.appendChild(note);
        }
        if (!msg.entry.text.trim() && !msg.entry.stopped) streaming.el.remove();
      } else if (msg.entry.kind === "assistant") {
        addAssistant(msg.entry.text, msg.entry.stopped);
      }
      streaming = null;
      scrollDown();
      break;
    case "busy":
      setBusy(msg.busy);
      break;
    case "servers":
      renderServers(msg.servers);
      break;
  }
});

post({ type: "chatReady" });
input.focus();
