import { app, dialog } from "electron";
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
import { buildBundle, redactPaths, redactSettings, textFile, zipStore } from "./diagnosticsCore";

/** Everything the bundle holds is built here; nothing is sent anywhere. */
export async function exportDiagnostics(extra: { statuses?: () => unknown } = {}): Promise<void> {
  try {
    const dest = await showSaveDialog({
      title: t("Export Diagnostics…"),
      defaultPath: path.join(app.getPath("documents"), `kkss-diagnostics-${new Date().toISOString().slice(0, 10)}.zip`),
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (!dest) return;
    const r = { home: os.homedir(), tmp: os.tmpdir() };
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
    ];
    await writeFileAtomic(dest, Buffer.from(zipStore(buildBundle(files, new Date().toISOString()))));
    toast("info", t("Diagnostics written to {0}", { 0: dest }));
  } catch (err) {
    void dialog.showErrorBox(t("Export Diagnostics…"), (err as Error).message);
  }
}
