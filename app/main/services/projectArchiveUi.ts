import * as path from "node:path";
import { dialog } from "electron";
import { t } from "../../shared/i18n";
import { showOpenDialog, showSaveDialog } from "./dialogs";
import { toast } from "./notifications";
import type { WorkflowService } from "./workflows/service";

interface PackResult { archive: string; files: number; missing: string[]; external: unknown[] }
interface UnpackResult { unpacked: boolean; reason?: string; destination?: string; files?: number; problems?: unknown[]; externalReferences?: { exists: boolean }[] }

/** File ▸ Export Project Archive… — the same code path as `app__project_pack`. */
export async function exportProjectArchive(workflows: WorkflowService | undefined): Promise<void> {
  try {
    if (!workflows) throw new Error(t("Choose a project folder on Home first."));
    const out = await showSaveDialog({ title: t("Export Project Archive…"), defaultPath: "project.kkss.zip", filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (!out) return;
    const include = await dialog.showMessageBox({ type: "question", buttons: [t("Sources and meshes only"), t("Include run files"), t("Cancel")], defaultId: 0, cancelId: 2, message: t("What should the archive contain?") });
    if (include.response === 2) return;
    const r = (await workflows.projectPack({ outputPath: out, includeRuns: include.response === 1 })) as PackResult;
    toast(r.missing.length ? "warning" : "info", t("Archive written to {0}: {1} files, {2} missing, {3} external references not packed.", { 0: path.basename(r.archive), 1: r.files, 2: r.missing.length, 3: r.external.length }));
  } catch (err) {
    toast("error", (err as Error).message);
  }
}

/** File ▸ Import Project Archive… — unpacks into a folder the user picks; never overwrites. */
export async function importProjectArchive(workflows: WorkflowService | undefined): Promise<void> {
  try {
    if (!workflows) throw new Error(t("Choose a project folder on Home first."));
    const picked = await showOpenDialog({ title: t("Import Project Archive…"), filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (!picked?.[0]) return;
    const dest = await showOpenDialog({ title: t("Choose an empty folder to unpack into"), canSelectFolders: true, openLabel: t("Unpack here") });
    if (!dest?.[0]) return;
    const r = (await workflows.projectUnpack({ archivePath: picked[0], destination: dest[0] })) as UnpackResult;
    if (!r.unpacked) { toast("error", r.reason ?? t("Nothing was unpacked.")); return; }
    const unresolved = (r.externalReferences ?? []).filter((e) => !e.exists).length;
    toast((r.problems?.length || unresolved) ? "warning" : "info", t("Unpacked {0} files; {1} damaged or missing, {2} external references need relinking.", { 0: r.files ?? 0, 1: r.problems?.length ?? 0, 2: unresolved }));
  } catch (err) {
    toast("error", (err as Error).message);
  }
}
