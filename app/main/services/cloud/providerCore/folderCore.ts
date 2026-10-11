/**
 * The find-or-create rule every provider's `ensureFolder` follows. Pure: the
 * provider supplies how to look a folder up and how to make one, this owns the
 * ordering and the race handling so all three behave identically.
 */
import { CloudError, type CloudFile } from "../cloudCore";

export async function ensureFolderVia(opts: {
  label: string;
  name: string;
  /** Looks the folder up; may return a non-folder item sharing the name. */
  find(): Promise<CloudFile | undefined>;
  make(): Promise<CloudFile>;
}): Promise<CloudFile> {
  const accept = (item: CloudFile): CloudFile => {
    if (item.isFolder) return item;
    // Replacing a file with a folder would destroy the user's data.
    throw new CloudError(
      "conflict",
      `${opts.label} has a file called "${opts.name}" where a folder is needed.`
    );
  };
  const existing = await opts.find();
  if (existing) return accept(existing);
  try {
    return await opts.make();
  } catch (err) {
    // Another writer (or an earlier, interrupted pass) created it between our
    // lookup and our create — that is the outcome we wanted, not a failure.
    if (err instanceof CloudError && err.kind === "conflict") {
      const raced = await opts.find();
      if (raced) return accept(raced);
    }
    throw err;
  }
}
