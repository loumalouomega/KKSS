/**
 * Companion transfer: the files a staged document needs beyond its sidecars —
 * XDMF's sibling `.h5`, an OpenFOAM case's `constant/polyMesh/` tree — in both
 * directions. Which paths count is `cachePathCore.companionsFor`'s table; this
 * file only walks the remote and the staging directory.
 *
 * Effects are the provider and `node:fs`; there is no Electron import, so
 * `test/cloudCompanions.test.ts` drives it against a fake provider.
 *
 * Unlike sidecars (derived state; a missing one means "no edits yet"), a
 * companion is *document content*: a `.foam` without its polyMesh opens as
 * nothing, and a partial tree is worse than none. So downloads here fail loudly,
 * and uploads follow the document's conflict rule rather than the sidecars'.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { companionsFor, MAX_COMPANION_FILES, MAX_TREE_DEPTH, sanitizeFileName } from "./cachePathCore";
import { CloudError, type CloudFile } from "./cloudCore";
import type { CloudProvider, TransferOptions } from "./cloudProvider";
import type { CompanionBaseline } from "./manifestCore";

export interface DownloadedCompanions {
  baselines: Record<string, CompanionBaseline>;
  bytes: number;
}

/** A local name must equal the remote one, or the upload filter and the
 *  conflict baseline (both keyed by relative path) would silently disagree. */
function assertPortable(name: string): void {
  if (sanitizeFileName(name) !== name) {
    throw new CloudError(
      "other",
      `"${name}" cannot be stored under that name on this system, so the case cannot be opened from the cloud.`
    );
  }
}

/**
 * Downloads every companion that exists remotely beside the document into
 * `dir`, mirroring the relative layout. An absent file or folder is fine (a
 * case may not be meshed yet); any download failure aborts the stage.
 */
export async function downloadCompanions(
  provider: CloudProvider,
  parentId: string,
  modelName: string,
  dir: string,
  options: TransferOptions = {}
): Promise<DownloadedCompanions> {
  const { siblings, trees } = companionsFor(modelName);
  const baselines: Record<string, CompanionBaseline> = {};
  let bytes = 0;

  const fetch = async (file: CloudFile, rel: string) => {
    if (Object.keys(baselines).length >= MAX_COMPANION_FILES) {
      throw new CloudError(
        "other",
        `${modelName} has more than ${MAX_COMPANION_FILES} companion files; KKSS will not download them all.`
      );
    }
    const dest = path.join(dir, ...rel.split("/"));
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await provider.download(file, dest, options);
    baselines[rel] = { rev: file.rev, precondition: file.precondition };
    bytes += file.size ?? 0;
  };

  for (const name of siblings) {
    const file = await provider.findChild(parentId, name);
    if (file && !file.isFolder) await fetch(file, name);
  }

  for (const tree of trees) {
    let folderId: string | undefined = parentId;
    for (const segment of tree.split("/")) {
      const child: CloudFile | undefined = await provider.findChild(folderId, segment);
      folderId = child?.isFolder ? child.id : undefined;
      if (!folderId) break;
    }
    if (folderId) await walk(folderId, tree, 1);
  }

  async function walk(folderId: string, rel: string, depth: number): Promise<void> {
    let pageToken: string | undefined;
    do {
      const page = await provider.list(folderId, pageToken);
      for (const item of page.files) {
        assertPortable(item.name);
        const childRel = `${rel}/${item.name}`;
        if (!item.isFolder) {
          await fetch(item, childRel);
        } else if (depth < MAX_TREE_DEPTH) {
          await walk(item.id, childRel, depth + 1);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  return { baselines, bytes };
}

/**
 * Resolves (creating as needed) the remote folder for a relative directory,
 * once per pass: a six-file polyMesh upload asks for `constant/polyMesh` six
 * times but the provider hears about it once.
 */
export class RemoteFolders {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly provider: CloudProvider,
    private readonly rootId: string
  ) {}

  /** Folder id for `relDir` ("" ⇒ the document's own folder). */
  resolve(relDir: string): Promise<string> {
    if (!relDir) return Promise.resolve(this.rootId);
    let pending = this.cache.get(relDir);
    if (!pending) {
      const cut = relDir.lastIndexOf("/");
      const parent = cut < 0 ? "" : relDir.slice(0, cut);
      const name = relDir.slice(cut + 1);
      pending = this.resolve(parent).then(
        async (parentId) => (await this.provider.ensureFolder(parentId, name)).id
      );
      // A failed attempt must not be cached, or every retry in this pass
      // would replay the same rejection.
      pending.catch(() => this.cache.delete(relDir));
      this.cache.set(relDir, pending);
    }
    return pending;
  }
}
