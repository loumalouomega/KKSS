/** The script-free export report used when packing outside a mesh preview. */
import { BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { currentAppearance, windowBackground } from "./appearance";
import { toast } from "./notifications";

const windows = new Set<BrowserWindow>();

export function createStaticReportPanel(title: string): { webview: { html: string } } {
  const win = new BrowserWindow({
    title,
    width: 780,
    height: 680,
    show: false,
    backgroundColor: windowBackground(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
    },
  });
  windows.add(win);
  win.on("closed", () => windows.delete(win));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let html = "";
  return {
    webview: {
      get html() { return html; },
      set html(value: string) {
        // Upstream supplies escaped, script-free HTML with its own restrictive
        // CSP. Embed our trusted token sheet: that CSP permits inline CSS only.
        const css = fs.readFileSync(path.join(__dirname, "renderer/theme/vscode-vars.css"), "utf8");
        html = value;
        const themed = value
          .replace("</head>", `<style>${css}</style></head>`)
          .replace("<body>", `<body class="${currentAppearance().kind}">`);
        void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(themed)}`).then(() => {
          if (!win.isDestroyed()) win.show();
        }).catch((error: unknown) => {
          if (!win.isDestroyed()) win.close();
          toast("error", `Could not open export report: ${String(error)}`);
        });
      },
    },
  };
}
