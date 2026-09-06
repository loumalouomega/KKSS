/**
 * Chat sidebar renderer: message list with streaming assistant text,
 * expandable tool-call chips, MCP server status dots, and the composer.
 * Model output is rendered with a tiny markdown-lite formatter built purely
 * from createElement/textContent — no innerHTML of untrusted text, so the
 * page keeps the strict CSP.
 */
import type { ChatConversationInfo, ChatServerStatus, ChatToHost, ChatToWebview, ChatWireEntry } from "../../main/ipc";

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

let busy = false;
/** The assistant bubble currently receiving stream deltas. */
let streaming: { el: HTMLDivElement; text: string } | null = null;
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

  messages.appendChild(details);
  scrollDown();
}

function resolveToolChip(entry: Extract<ChatWireEntry, { kind: "toolResult" }>): void {
  const chips = messages.querySelectorAll<HTMLDetailsElement>(`details.tool[data-call-id="${CSS.escape(entry.callId)}"]`);
  const chip = chips[chips.length - 1];
  if (!chip) return;
  const status = chip.querySelector<HTMLSpanElement>(".tool-status");
  if (status) {
    status.classList.remove("running");
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

// ---- busy / composer state ---------------------------------------------------

function setBusy(value: boolean): void {
  busy = value;
  sendBtn.textContent = busy ? "Stop" : "Send";
  sendBtn.classList.toggle("stop", busy);
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
      // The tooltip stays the provider label; the visible name is the
      // conversation, which is what tells two of them apart.
      titleEl.title = msg.providerLabel;
      titleEl.textContent = msg.conversationTitle || "AI Chat";
      renderConversations(msg.conversations, msg.conversationId);
      msg.entries.forEach(addEntry);
      renderServers(msg.servers);
      setBusy(msg.busy);
      scrollDown(true);
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
