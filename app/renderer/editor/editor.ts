/** Text-editor renderer: CodeMirror 6 over the editorApi IPC bridge. */
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import type { EditorLanguage, EditorToWebview } from "../../main/ipc";
import type { Appearance } from "../appearance";

declare global {
  interface Window {
    editorApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.editorApi;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pathEl = byId<HTMLSpanElement>("editor-path");

const language = new Compartment();
/** Settings ▸ Text Editor + the UI theme's light/dark syntax palette. */
const preferences = new Compartment();
let appearance = window.kkssAppearance?.current();

function preferenceExtensions(a: Appearance | undefined): Extension {
  const e = a?.editor;
  const light = a?.kind === "vscode-light" || a?.kind === "vscode-high-contrast-light";
  const tab = e?.tabSize ?? 4;
  return [
    // basicSetup's default highlight style is the light one; oneDark replaces it.
    light ? [] : oneDark,
    EditorState.tabSize.of(tab),
    indentUnit.of(" ".repeat(tab)),
    e?.wordWrap ? EditorView.lineWrapping : [],
    EditorView.theme({
      "&": { fontSize: `${e?.fontSize ?? 13}px` },
      ".cm-content, .cm-gutters": e?.fontFamily ? { fontFamily: e.fontFamily } : {},
      // basicSetup always installs the gutter; hiding it is the switch-off.
      ".cm-lineNumbers": e?.lineNumbers === false ? { display: "none" } : {},
    }),
  ];
}
let currentPath: string | null = null;
let dirty = false;
let loading = false;

function languageExtension(lang: EditorLanguage): Extension {
  if (lang === "json") return json();
  if (lang === "python") return python();
  return [];
}

function renderPath(): void {
  pathEl.textContent = currentPath ?? "No file open — use Open…";
  if (currentPath && dirty) {
    const dot = document.createElement("span");
    dot.className = "ui-dot";
    dot.title = "Unsaved changes";
    pathEl.append(dot);
  }
}

function setDirty(value: boolean): void {
  if (dirty === value) return;
  dirty = value;
  api.post({ type: "dirty", dirty });
  renderPath();
}

function save(saveAs: boolean): void {
  api.post({ type: "saveContent", content: view.state.doc.toString(), saveAs });
}

const extensions = (lang: EditorLanguage): Extension[] => [
  // Our keymap first so Mod-s wins over any basicSetup binding.
  keymap.of([
    { key: "Mod-s", run: () => (save(false), true) },
    { key: "Mod-Shift-s", run: () => (save(true), true) },
  ]),
  basicSetup,
  preferences.of(preferenceExtensions(appearance)),
  language.of(languageExtension(lang)),
  EditorView.updateListener.of((update) => {
    if (update.docChanged && !loading) setDirty(true);
  }),
];

const view = new EditorView({
  parent: byId<HTMLDivElement>("editor-host"),
  state: EditorState.create({ doc: "", extensions: extensions("plain") }),
});

window.kkssAppearance?.onChange((a) => {
  appearance = a;
  view.dispatch({ effects: preferences.reconfigure(preferenceExtensions(a)) });
});

api.onMessage((raw) => {
  const msg = raw as EditorToWebview;
  switch (msg.type) {
    case "doc":
      loading = true;
      view.setState(EditorState.create({ doc: msg.content, extensions: extensions(msg.language) }));
      loading = false;
      currentPath = msg.path;
      dirty = false;
      renderPath();
      view.focus();
      break;
    case "saved":
      currentPath = msg.path;
      dirty = false;
      renderPath();
      break;
    case "requestSave":
      save(msg.saveAs);
      break;
  }
});

byId<HTMLButtonElement>("open-btn").addEventListener("click", () => api.post({ type: "openFile" }));
byId<HTMLButtonElement>("save-btn").addEventListener("click", () => save(false));
byId<HTMLButtonElement>("save-as-btn").addEventListener("click", () => save(true));

renderPath();
api.post({ type: "editorReady" });
