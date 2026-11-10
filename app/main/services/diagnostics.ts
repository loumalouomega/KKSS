import { app, dialog } from "electron";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { t } from "../../shared/i18n";
import { showSaveDialog } from "./dialogs";
import { writeFileAtomic } from "./atomicWrite";
import { toast } from "./notifications";
import { stateStore } from "./stateStore";
import { registry, effective } from "./settings/registry";
import { hasSecret } from "./chat/secrets";
import { KRATOS_MCP_VERSION } from "./chat/kratosMcpVersion";
import { eventLog } from "./eventLog";
import { buildBundle, redactPaths, redactSettings, textFile, zipStore, type DiagnosticFile } from "./diagnosticsCore";
import { pickDumps } from "./crashDumps";
import { describeDump } from "./crashDumpsCore";

/** Everything the bundle holds is built here; nothing is sent anywhere. */
export async function exportDiagnostics(extra: { statuses?: () => unknown; runFiles?: () => Promise<{ name: string; text: string }[]> } = {}): Promise<void> {
  try {
    const dest = await showSaveDialog({
      title: t("Export Diagnostics…"),
      defaultPath: path.join(app.getPath("documents"), `kkss-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`),
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (!dest) return;
    const r = { home: os.homedir(), tmp: os.tmpdir() };
    const dumps = await pickDumps().catch(() => ({ included: [], skipped: [] }));
    const dumpFiles: DiagnosticFile[] = [];
    if (dumps.included.length > 0) {
      // A dump is a memory snapshot: it can hold file paths and pieces of open
      // documents. It is included only on an explicit answer, never by default.
      const { response } = await dialog.showMessageBox({
        type: "question",
        title: t("Export Diagnostics…"),
        message: t("Include {0} crash dump(s)?", { 0: String(dumps.included.length) }),
        detail: t("Crash dumps are memory snapshots and can contain file paths and fragments of the documents you had open. They stay on this computer unless you share the zip."),
        buttons: [t("Don't include"), t("Include"), t("Cancel")],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) return;
      if (response === 1)
        for (const d of dumps.included) dumpFiles.push({ name: `crash-dumps/${d.name}`, data: new Uint8Array(await fs.readFile(d.file)) });
    }
    const settings = redactSettings(registry(), (e) => effective(e, e.storeKey ? stateStore.get(e.storeKey) : undefined), (e) => !!e.storeKey && hasSecret(e.storeKey));
    const json = (v: unknown) => redactPaths(JSON.stringify(v, null, 2), r);
    const versions = {
      app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
      platform: process.platform, arch: process.arch, packaged: app.isPackaged, kratosMcpServer: KRATOS_MCP_VERSION,
    };
    const files = [
      textFile("versions.json", json(versions)),
      textFile("settings.json", json(settings)),
      textFile("mcp-servers.json", json(extra.statuses?.() ?? null)),
      textFile("events.json", json(eventLog.events())),
      textFile("main-log-tail.txt", redactPaths(eventLog.tail().join("\n") + "\n", r)),
      // Listed whether or not they are included, so a report can say a crash happened.
      textFile("crash-dumps.json", json({ included: dumpFiles.length > 0, available: dumps.included.map(describeDump), skipped: dumps.skipped.map(describeDump) })),
      ...dumpFiles,
    ];
    for (const f of (await extra.runFiles?.().catch(() => [])) ?? []) files.push(textFile(f.name, redactPaths(f.text, r)));
    await writeFileAtomic(dest, Buffer.from(zipStore(buildBundle(files, new Date().toISOString()))));
    toast("info", t("Diagnostics written to {0}", { 0: dest }));
  } catch (err) {
    void dialog.showErrorBox(t("Export Diagnostics…"), (err as Error).message);
  }
}
