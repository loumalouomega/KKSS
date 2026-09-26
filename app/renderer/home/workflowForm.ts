import { t } from "../../shared/i18n";

export interface WorkflowField {
  name: string;
  label: string;
  value?: string;
  optional?: boolean;
  choices?: readonly string[];
  multiline?: boolean;
}

/** One inline interaction at a time. Values remain mounted after a failed call. */
export class WorkflowForm {
  private panel = document.createElement("form");
  private fields = document.createElement("fieldset");
  private error = document.createElement("div");
  private submit = document.createElement("button");
  private cancel = document.createElement("button");
  private origin?: HTMLElement;
  private pending = false;
  private locked: HTMLElement[] = [];
  constructor(private container: HTMLElement, private context: () => string = () => "") {
    this.panel.id = "workflow-form";
    this.panel.className = "card workflow-form";
    this.panel.hidden = true;
    this.panel.noValidate = true;
    this.error.id = "workflow-form-error";
    this.error.setAttribute("role", "alert");
    this.submit.type = "submit"; this.submit.className = "btn btn-primary";
    this.cancel.type = "button"; this.cancel.className = "btn btn-secondary";
    this.cancel.textContent = t("Cancel");
    this.cancel.addEventListener("click", () => this.close());
    this.panel.addEventListener("keydown", event => {
      if (event.key === "Escape" && !this.pending) { event.preventDefault(); this.close(); }
    });
    this.container.append(this.panel);
  }
  open(title: string, fields: WorkflowField[], accept: (values: Record<string, string>) => void, detail = ""): void {
    if (this.pending || !this.panel.hidden) return;
    const context = this.context();
    this.origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.locked = [...this.container.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== this.panel && !el.inert);
    for (const el of this.locked) el.inert = true;
    const heading = document.createElement("h3"); heading.id = "workflow-form-title"; heading.textContent = title;
    this.panel.setAttribute("aria-labelledby", heading.id);
    const summary = document.createElement("p"); summary.className = "workflow-form-summary"; summary.textContent = detail; summary.hidden = !detail;
    this.container.classList.add("workflow-editing");
    this.fields.className = fields.length >= 6 ? "workflow-form-grid" : "";
    this.fields.replaceChildren();
    for (const field of fields) {
      const label = document.createElement("label"); label.className = "workflow-form-field";
      if (field.multiline || field.name === "resultPath" || field.name === "region") label.classList.add("workflow-form-wide");
      const caption = document.createElement("span"); caption.textContent = field.label;
      const input = document.createElement(field.choices ? "select" : field.multiline ? "textarea" : "input");
      input.className = "field";
      input.name = field.name; input.id = `workflow-input-${field.name}`;
      input.required = !field.optional;
      if (input instanceof HTMLSelectElement) for (const value of field.choices!) {
        const option = document.createElement("option"); option.value = value; option.textContent = value; input.append(option);
      }
      input.value = field.value ?? "";
      label.append(caption, input); this.fields.append(label);
    }
    this.submit.textContent = title;
    const actions = document.createElement("div"); actions.className = "workflow-actions"; actions.append(this.submit, this.cancel);
    this.panel.replaceChildren(heading, summary, this.fields, this.error, actions);
    this.error.textContent = ""; this.setBusy(false); this.panel.hidden = false;
    this.panel.onsubmit = event => {
      event.preventDefault(); if (this.pending) return;
      this.error.textContent = "";
      if (context !== this.context()) { this.fail(t("The project changed. Cancel and reopen this form.")); return; }
      const values: Record<string, string> = {};
      for (const field of fields) {
        const input = this.fields.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${field.name}"]`)!;
        const value = input.value.trim();
        if (!field.optional && !value) { this.fail(t("Enter a value for {0}.", {0: field.label})); input.focus(); return; }
        values[field.name] = value;
      }
      try { accept(values); } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
    };
    (this.fields.querySelector<HTMLElement>("input, select, textarea") ?? this.submit).focus();
    this.panel.scrollIntoView({ block: "nearest" });
  }
  setBusy(value: boolean): void {
    this.pending = value; this.fields.disabled = value; this.submit.disabled = value; this.cancel.disabled = value;
    this.panel.setAttribute("aria-busy", String(value));
  }
  fail(message: string): void { this.setBusy(false); this.error.textContent = message; }
  close(): void {
    if (this.pending || this.panel.hidden) return;
    this.panel.hidden = true;
    this.container.classList.remove("workflow-editing");
    for (const el of this.locked) el.inert = false;
    this.locked = [];
    this.origin?.focus();
  }
  complete(): void { this.setBusy(false); this.close(); }
}
