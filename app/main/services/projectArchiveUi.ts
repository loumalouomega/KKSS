import * as path from "node:path";
import { dialog } from "electron";
import { t } from "../../shared/i18n";
import { showOpenDialog, showSaveDialog } from "./dialogs";
import { toast } from "./notifications";
import type { WorkflowService } from "./workflows/service";
import { relinkPlan, type UnresolvedExternal } from "./workflows/projectArchive";

/** Run artifacts can number in the hundreds; the prompt stops here and the rest stay listed. */
const MAX_RELOCATE_PROMPTS = 25;

interface PackResult { archive: string; files: number; missing: string[]; external: unknown[] }
interface UnpackResult { unpacked: boolean; reason?: string; destination?: string; files?: number; problems?: unknown[]; externalReferences?: { exists: boolean }[]; unresolvedExternal?: UnresolvedExternal[] }

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
export async function importProjectArchive(workflows: WorkflowService | undefined, projectRoot: { set(dir: string): void }): Promise<void> {
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
    const { relinkable, relocatable } = relinkPlan(r.unresolvedExternal ?? []);
    if (relinkable.length === 0 && relocatable.length === 0) return;
    // Relinking edits the selected project, so the prompt first offers to make the unpacked folder that project.
    const ask = await dialog.showMessageBox({
      type: "question",
      buttons: [t("Relink files…"), t("Not now")],
      defaultId: 0,
      cancelId: 1,
      message: t("{0} study geometry file(s) and {1} other referenced file(s) are not on this machine.", { 0: relinkable.length, 1: relocatable.length }),
      detail: t("Use the unpacked folder as the project root and choose each file. A geometry file may be a replacement; any other file must be the same bytes, moved."),
    });
    if (ask.response !== 0) return;
    projectRoot.set(dest[0]);
    let done = 0, refused = 0;
    for (const u of relinkable) {
      const file = await showOpenDialog({ title: t("Locate the geometry file for this study"), defaultPath: path.dirname(u.path) });
      if (!file?.[0]) continue;
      await workflows.relinkSource(u.studyId, file[0]);
      done += 1;
    }
    for (const u of relocatable.slice(0, MAX_RELOCATE_PROMPTS)) {
      const file = await showOpenDialog({ title: t("Locate {0} (moved file)", { 0: path.basename(u.path) }), defaultPath: path.dirname(u.path) });
      if (!file?.[0]) continue;
      const out = (await workflows.relinkReference({ studyId: u.studyId, role: u.role, from: u.path, path: file[0] })) as { relinked?: boolean };
      if (out.relinked) done += 1; else refused += 1;
    }
    const total = relinkable.length + Math.min(relocatable.length, MAX_RELOCATE_PROMPTS);
    toast(done === total ? "info" : "warning", t("Relinked {0} of {1} references; {2} refused because the file differs from the recorded one.", { 0: done, 1: total, 2: refused }));
  } catch (err) {
    toast("error", (err as Error).message);
  }
}
