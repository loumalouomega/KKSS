import { dialog } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../../shared/i18n";
import { showOpenDialog } from "./dialogs";
import { planExample, isExampleId, EXAMPLES } from "./examplesCore";
import { toast } from "./notifications";

/**
 * Help ▸ Examples ▸ <case>: unpacks the shipped tutorial case into a folder the
 * user picks and opens its starting document (the CAD geometry, else the mesh)
 * through the one `openFile` path. Solver output is not shipped, so there are
 * no results to open. The zips live in `out/examples/` (esbuild.mjs).
 */
export async function openExample(
  id: string,
  outDir: string,
  open: (fsPath: string) => Promise<unknown>,
): Promise<void> {
  if (!isExampleId(id)) return;
  const label = t(EXAMPLES.find((e) => e.id === id)!.label);
  try {
    const zipPath = path.join(outDir, "examples", `${id}.zip`);
    if (!fs.existsSync(zipPath)) {
      toast("error", t("The example archive is missing from this build."));
      return;
    }
    const picked = await showOpenDialog({
      title: t("Choose a folder for the example"),
      openLabel: t("Extract here"),
      canSelectFolders: true,
    });
    if (!picked?.[0]) return;

    const plan = planExample(id, new Uint8Array(fs.readFileSync(zipPath)));
    const root = path.resolve(picked[0]);
    const target = path.join(root, id);
    if (fs.existsSync(target)) {
      const { response } = await dialog.showMessageBox({
        type: "question",
        buttons: [t("Replace files"), t("Cancel")],
        defaultId: 1,
        cancelId: 1,
        message: t("{0} already exists in that folder.", { 0: id }),
        detail: t("Files with the same names are overwritten; other files are kept."),
      });
      if (response !== 0) return;
    }
    for (const file of plan.files) {
      const dest = path.resolve(root, file.rel);
      if (!dest.startsWith(root + path.sep)) throw new Error(`Unsafe path: ${file.rel}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.data);
    }
    toast("info", t("{0} extracted to {1}", { 0: label, 1: target }));
    await open(path.join(root, plan.entry));
  } catch (err) {
    toast("error", t("Could not open the example: {0}", { 0: (err as Error).message }));
  }
}
