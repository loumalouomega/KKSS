/**
 * The sidebar's MCP manager: lists every tool server (built-in, yours and the
 * project folder's), restarts them, adds/edits/removes your own, marks which of
 * their tools are read-only, and holds the project-folder trust decision.
 *
 * The panel never sees a stored secret — rows carry env variable *names* and a
 * `tokenSet` flag — and it decides nothing: main validates every message and
 * answers a refusal with `mcpError`. Built from createElement/textContent only,
 * so the page keeps its strict CSP (no innerHTML, no `style=`).
 */
import { t } from "../../shared/i18n";
import type { ChatMcpMark, ChatMcpProject, ChatMcpServerRow, ChatMcpToolInfo, ChatToHost, ChatToWebview } from "../../main/ipc";
import { glyph } from "../glyphs";
import { buildInput, joinArgs, orderRows, projectActions, rowActions, type FormValues } from "./mcpManagerView";

type Msg = Extract<ChatToWebview, { type: "mcpManager" | "mcpTools" | "mcpError" | "mcpOpen" | "mcpSaved" }>;
type View = { kind: "list" } | { kind: "form"; editing?: ChatMcpServerRow } | { kind: "tools"; id: string };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", `btn btn-sm ${className}`.trim(), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

let fieldCounter = 0;
/** A labelled control; the label is wired by id so a screen reader announces it. */
function field(label: string, control: HTMLInputElement | HTMLSelectElement, hint?: string): HTMLDivElement {
  const id = `mcp-f${++fieldCounter}`;
  control.id = id;
  control.classList.add("field");
  const wrap = el("div", "mcp-field");
  const l = el("label", undefined, label);
  l.htmlFor = id;
  wrap.append(l, control);
  if (hint) wrap.appendChild(el("p", "mcp-hint", hint));
  return wrap;
}

export interface McpManagerElements {
  panel: HTMLElement;
  body: HTMLElement;
  openBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
}

export class McpManager {
  private rows: ChatMcpServerRow[] = [];
  private project: ChatMcpProject = { state: "none", errors: [] };
  private managed = false;
  private view: View = { kind: "list" };
  private tools = new Map<string, ChatMcpToolInfo[]>();
  private error = "";
  /** The alert node of the current render; the form updates it in place so a
   *  refusal never rebuilds (and empties) the form the user is typing in. */
  private errorEl: HTMLDivElement | null = null;
  private armed: string | null = null;
  private armTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ui: McpManagerElements, private readonly host: (message: ChatToHost) => void) {
    ui.openBtn.addEventListener("click", () => (this.isOpen() ? this.close() : this.open()));
    ui.closeBtn.addEventListener("click", () => this.close());
    ui.panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (this.view.kind === "list") this.close(); else this.show({ kind: "list" });
    });
  }

  isOpen(): boolean { return !this.ui.panel.hidden; }

  /** Every user action goes through here: a new action clears the previous refusal. */
  private post(message: ChatToHost): void {
    this.setError("");
    this.host(message);
  }

  open(): void {
    this.ui.panel.hidden = false;
    this.ui.openBtn.setAttribute("aria-expanded", "true");
    this.post({ type: "mcpRefresh" });
    this.show({ kind: "list" });
  }

  close(): void {
    this.ui.panel.hidden = true;
    this.ui.openBtn.setAttribute("aria-expanded", "false");
    this.ui.openBtn.focus();
  }

  handle(msg: Msg): void {
    switch (msg.type) {
      case "mcpManager":
        this.rows = msg.rows;
        this.project = msg.project;
        this.managed = msg.managed;
        // Status pushes arrive constantly while servers start; repainting the form
        // under someone typing in it would throw their input away.
        if (this.view.kind === "form") return;
        break;
      case "mcpSaved":
        if (this.view.kind === "form") this.show({ kind: "list" });
        return;
      case "mcpTools":
        this.tools.set(msg.id, msg.tools);
        break;
      case "mcpError":
        this.setError(this.describeError(msg.code, msg.detail));
        return;
      case "mcpOpen":
        if (!this.isOpen()) this.open();
        return;
    }
    if (this.isOpen()) this.render();
  }

  private describeError(code: string, detail?: string): string {
    switch (code) {
      case "managed": return t("These settings are locked by your administrator.");
      case "reserved": return t("That id is reserved for a built-in server.");
      case "unknown": return t("That server no longer exists.");
      case "invalid": return detail ? t("Not saved: {0}", { 0: detail }) : t("Not saved: the values are not valid.");
      default: return detail ? t("Something went wrong: {0}", { 0: detail }) : t("Something went wrong.");
    }
  }

  /** Shows (or clears) the panel's alert without repainting the view. */
  private setError(text: string): void {
    this.error = text;
    if (this.errorEl) {
      this.errorEl.textContent = text;
      this.errorEl.hidden = !text;
      if (text) this.ui.body.scrollTop = 0; // the alert sits at the top; make sure it is seen
    } else if (this.isOpen()) {
      this.render();
    }
  }

  private show(view: View): void {
    this.view = view;
    this.error = "";
    this.armed = null;
    this.render();
    // Land on the first control of the new view: the old one is gone from the DOM.
    const first = this.ui.body.querySelector<HTMLElement>("input, select, button");
    first?.focus();
  }

  private render(): void {
    // Keep the scroll position of a list that repaints on every status change.
    const scroll = this.ui.body.scrollTop;
    this.ui.body.replaceChildren();
    const note = el("div", "mcp-error", this.error);
    note.setAttribute("role", "alert");
    note.hidden = !this.error;
    this.errorEl = note;
    this.ui.body.appendChild(note);
    if (this.view.kind === "form") this.renderForm(this.view.editing);
    else if (this.view.kind === "tools") this.renderTools(this.view.id);
    else this.renderList();
    this.ui.body.scrollTop = scroll;
  }

  // ------------------------------------------------------------------ list

  private stateText(row: ChatMcpServerRow): string {
    switch (row.state) {
      case "ready": {
        const base = t("{0} tools", { 0: row.toolCount ?? 0 });
        return row.skippedTools ? `${base} · ${t("{0} left out (unusable names)", { 0: row.skippedTools })}` : base;
      }
      case "starting": return t("starting…");
      case "disabled": return t("disabled");
      case "untrusted": return t("waiting for you to trust the project folder");
      default: return t("unavailable — {0}", { 0: row.error ?? t("unknown error") });
    }
  }

  private badge(row: ChatMcpServerRow): string {
    return row.source === "builtin" ? t("built-in") : row.source === "user" ? t("yours") : t("project");
  }

  private renderList(): void {
    const body = this.ui.body;
    body.appendChild(el("p", "mcp-intro", t("Tools from servers you add ask for approval until you mark them read-only. Built-in servers are managed by KKSS.")));
    const list = el("ul", "mcp-list");
    for (const row of orderRows(this.rows)) list.appendChild(this.rowItem(row));
    body.appendChild(list);
    const add = button(t("Add server"), "btn-primary", () => this.show({ kind: "form" }));
    add.disabled = this.managed;
    const actions = el("div", "mcp-actions");
    actions.appendChild(add);
    body.appendChild(actions);
    body.appendChild(this.projectSection());
  }

  private rowItem(row: ChatMcpServerRow): HTMLLIElement {
    const li = el("li", "mcp-row");
    const head = el("div", "mcp-row-head");
    head.appendChild(el("span", `server-dot ${row.state}`));
    head.appendChild(el("span", "mcp-name", row.name));
    head.appendChild(el("span", "ui-badge", this.badge(row)));
    head.appendChild(el("span", "mcp-transport", row.transport === "http" ? "HTTP" : "stdio"));
    li.appendChild(head);
    const status = el("div", `mcp-status ${row.state}`, this.stateText(row));
    li.appendChild(status);
    const what = row.transport === "http" ? row.url : row.command ? [row.command, ...(row.args ?? [])].join(" ") : "";
    if (what && row.source !== "builtin") li.appendChild(el("code", "mcp-launch", what));
    const can = rowActions(row, this.managed);
    const actions = el("div", "mcp-row-actions");
    if (can.tools) actions.appendChild(button(t("Tools"), "btn-secondary", () => { this.post({ type: "mcpToolsRequest", id: row.id }); this.show({ kind: "tools", id: row.id }); }));
    if (can.restart) actions.appendChild(button(t("Restart"), "btn-secondary", () => this.post({ type: "mcpRestart", id: row.id })));
    if (can.toggle) actions.appendChild(button(row.enabled ? t("Disable") : t("Enable"), "btn-secondary", () => this.post({ type: "mcpSetEnabled", id: row.id, enabled: !row.enabled })));
    if (can.edit) actions.appendChild(button(t("Edit"), "btn-secondary", () => this.show({ kind: "form", editing: row })));
    if (can.remove) {
      const armed = this.armed === row.id;
      const remove = button(armed ? t("Click again to remove") : t("Remove"), armed ? "mcp-armed" : "btn-secondary", () => {
        if (this.armed === row.id) { this.armed = null; this.post({ type: "mcpRemoveServer", id: row.id }); return; }
        this.armed = row.id;
        clearTimeout(this.armTimer);
        // A destructive second click must be deliberate: the arming lapses.
        this.armTimer = setTimeout(() => { this.armed = null; if (this.isOpen() && this.view.kind === "list") this.render(); }, 4000);
        this.render();
      });
      actions.appendChild(remove);
    }
    if (actions.childElementCount) li.appendChild(actions);
    return li;
  }

  private projectSection(): HTMLElement {
    const section = el("section", "mcp-project");
    section.appendChild(el("h3", "eyebrow", t("Project folder")));
    const p = this.project;
    const text = !p.root
      ? t("No project folder is set. Choose one with File ▸ Open Folder… to load its .kkss/assistant/mcp.json.")
      : p.state === "none"
        ? t("No .kkss/assistant/mcp.json in {0}.", { 0: p.root })
        : p.state === "trusted"
          ? t("Trusted. Any edit to the definition files asks again.")
          : p.state === "changed"
            ? t("The definition files changed since you trusted them. Read them, then trust again.")
            : p.state === "invalid"
              ? t("The definition files cannot be used.")
              : t("Not trusted yet. These files can make KKSS run commands on your computer — read them before you trust them.");
    section.appendChild(el("p", "mcp-hint", text));
    if (p.root) section.appendChild(el("code", "mcp-launch", p.root));
    if (p.shortHash) section.appendChild(el("p", "mcp-hint", t("Definitions {0}", { 0: p.shortHash })));
    for (const message of p.errors) section.appendChild(el("p", "mcp-error", message));
    const can = projectActions(p, this.managed);
    const actions = el("div", "mcp-actions");
    if (can.trust) actions.appendChild(button(t("Trust this folder"), "btn-primary", () => this.post({ type: "mcpTrustProject" })));
    if (can.revoke) actions.appendChild(button(t("Revoke trust"), "btn-secondary", () => this.post({ type: "mcpRevokeProject" })));
    if (can.reload) actions.appendChild(button(t("Reload"), "btn-secondary", () => this.post({ type: "mcpReloadProject" })));
    if (actions.childElementCount) section.appendChild(actions);
    return section;
  }

  // ------------------------------------------------------------------ tools

  private renderTools(id: string): void {
    const row = this.rows.find((r) => r.id === id);
    const body = this.ui.body;
    body.appendChild(button(t("Back"), "btn-secondary", () => this.show({ kind: "list" })));
    body.appendChild(el("h3", "eyebrow", t("Tools of {0}", { 0: row?.name ?? id })));
    const editable = row?.source !== "builtin";
    body.appendChild(el("p", "mcp-hint", editable
      ? t("A mark is your decision, not the server's. Marks apply only to this exact command or URL; changing it clears them.")
      : t("Built-in tool access is fixed by KKSS.")));
    const tools = this.tools.get(id) ?? [];
    if (!tools.length) body.appendChild(el("p", "mcp-hint", t("No tools reported.")));
    const list = el("ul", "mcp-list");
    for (const tool of tools) {
      const li = el("li", "mcp-row");
      li.appendChild(el("code", "mcp-name", tool.name));
      if (tool.description) li.appendChild(el("p", "mcp-hint", tool.description.length > 240 ? `${tool.description.slice(0, 240)}…` : tool.description));
      const select = el("select");
      for (const [value, label] of [["unknown", t("Ask each time")], ["read", t("Read-only — runs without asking")], ["write", t("Changes things — asks")]] as const) {
        const option = el("option", undefined, label);
        option.value = value;
        select.appendChild(option);
      }
      select.value = tool.mark;
      select.disabled = !editable || this.managed;
      select.addEventListener("change", () => this.post({ type: "mcpSetMark", id, tool: tool.name, mark: select.value as ChatMcpMark }));
      li.appendChild(field(t("Access"), select));
      list.appendChild(li);
    }
    body.appendChild(list);
  }

  // ------------------------------------------------------------------- form

  private renderForm(editing?: ChatMcpServerRow): void {
    const body = this.ui.body;
    body.appendChild(el("h3", "eyebrow", editing ? t("Edit server") : t("Add server")));

    const id = el("input"); id.type = "text"; id.maxLength = 32; id.spellcheck = false; id.value = editing?.id ?? "";
    id.readOnly = !!editing;
    const name = el("input"); name.type = "text"; name.maxLength = 80; name.value = editing && editing.name !== editing.id ? editing.name : "";
    const transport = el("select");
    for (const [value, label] of [["stdio", t("Local command")], ["http", t("HTTP URL")]] as const) {
      const option = el("option", undefined, label); option.value = value; transport.appendChild(option);
    }
    transport.value = editing?.transport ?? "stdio";
    const command = el("input"); command.type = "text"; command.spellcheck = false; command.value = editing?.command ?? "";
    const args = el("input"); args.type = "text"; args.spellcheck = false; args.value = joinArgs(editing?.args ?? []);
    const url = el("input"); url.type = "url"; url.spellcheck = false; url.value = editing?.url ?? "";
    const token = el("input"); token.type = "password"; token.autocomplete = "off";
    token.placeholder = editing?.tokenSet ? t("(stored — leave blank to keep)") : "";
    const clearToken = el("input"); clearToken.type = "checkbox";

    body.appendChild(field(t("Id"), id, t("Lowercase letters, digits and hyphens. It prefixes the tools: acme__lookup.")));
    body.appendChild(field(t("Name (optional)"), name));
    body.appendChild(field(t("Type"), transport));

    const stdioBox = el("div", "mcp-group");
    stdioBox.appendChild(field(t("Command"), command, t("Run directly, not through a shell.")));
    stdioBox.appendChild(field(t("Arguments"), args, t("Separated by spaces; use quotes to group.")));
    const envBox = el("div", "mcp-env");
    const envRows: Array<{ name: HTMLInputElement; value: HTMLInputElement }> = [];
    const addEnv = (envName = "", stored = false) => {
      const row = el("div", "mcp-env-row");
      const n = el("input"); n.type = "text"; n.spellcheck = false; n.value = envName; n.setAttribute("aria-label", t("Variable name"));
      const v = el("input"); v.type = "password"; v.autocomplete = "off"; v.setAttribute("aria-label", t("Variable value"));
      v.placeholder = stored ? t("(stored — leave blank to keep)") : t("value");
      n.classList.add("field"); v.classList.add("field");
      const remove = el("button", "icon-btn"); remove.type = "button"; remove.innerHTML = glyph("x"); remove.setAttribute("aria-label", t("Remove variable"));
      const entry = { name: n, value: v };
      remove.addEventListener("click", () => { envRows.splice(envRows.indexOf(entry), 1); row.remove(); });
      row.append(n, v, remove);
      envBox.appendChild(row);
      envRows.push(entry);
    };
    for (const envName of editing?.envNames ?? []) addEnv(envName, true);
    stdioBox.appendChild(el("p", "mcp-hint", t("Environment variables (values are stored encrypted and never shown again). The server also gets the basic PATH and HOME.")));
    stdioBox.appendChild(envBox);
    stdioBox.appendChild(button(t("Add variable"), "btn-secondary", () => addEnv()));

    const httpBox = el("div", "mcp-group");
    httpBox.appendChild(field(t("URL"), url, t("A bearer token is only sent over https, or to this computer.")));
    httpBox.appendChild(field(t("Bearer token (optional)"), token));
    if (editing?.tokenSet) {
      const wrap = el("label", "mcp-check");
      wrap.append(clearToken, document.createTextNode(` ${t("Remove the stored token")}`));
      httpBox.appendChild(wrap);
    }
    const sync = () => { stdioBox.hidden = transport.value !== "stdio"; httpBox.hidden = transport.value !== "http"; };
    transport.addEventListener("change", sync);
    sync();
    body.append(stdioBox, httpBox);

    const actions = el("div", "mcp-actions");
    actions.appendChild(button(t("Save"), "btn-primary", () => {
      const values: FormValues = {
        id: id.value, name: name.value, transport: transport.value as "stdio" | "http", command: command.value, args: args.value,
        url: url.value, env: envRows.map((r) => ({ name: r.name.value, value: r.value.value })), token: token.value, clearToken: clearToken.checked,
      };
      const built = buildInput(values);
      if (!built.ok) {
        this.setError(t("Fill in: {0}", { 0: built.problems.map((p) => (p === "id" ? t("Id") : p === "command" ? t("Command") : t("URL"))).join(", ") }));
        return;
      }
      this.post({ type: "mcpSaveServer", server: built.input });
      // Stay on the form until main answers: `mcpSaved` closes it, a refusal repaints it.
    }));
    actions.appendChild(button(t("Cancel"), "btn-secondary", () => this.show({ kind: "list" })));
    body.appendChild(actions);
  }
}
