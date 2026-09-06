/**
 * Pure parsing and query building for the Google Drive provider.
 *
 * Drive is **id-based**: there is no path concept at all, so browsing is a
 * parent drill-down from the literal alias `"root"` and `findChild` is a search
 * query rather than a lookup. That query is assembled by hand, which makes
 * quote escaping a correctness issue rather than a nicety — a model called
 * `O'Brien.stp` produces a malformed `q` and a 400 without it.
 */
import type { CloudAccount, CloudFile } from "../cloudCore";

export const DRIVE_ROOT = "root";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The fields Drive must be asked for explicitly — it returns almost nothing
 *  by default, and `headRevisionId` is our conflict baseline. */
export const FILE_FIELDS =
  "id,name,mimeType,size,md5Checksum,headRevisionId,modifiedTime,parents";
export const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

/**
 * Google-native documents (Docs, Sheets, …) have no binary content: `alt=media`
 * answers 403. They are filtered out of the listing rather than offered and
 * then failing at download time.
 */
export function isGoogleNative(mimeType: string | undefined): boolean {
  return (
    mimeType !== undefined &&
    mimeType.startsWith("application/vnd.google-apps.") &&
    mimeType !== FOLDER_MIME
  );
}

/** Escapes a value for Drive's `q` string literals: backslash first, then quote. */
export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function childrenQuery(parentId: string, name?: string): string {
  const clauses = [`'${escapeDriveQuery(parentId)}' in parents`, "trashed = false"];
  if (name !== undefined) clauses.push(`name = '${escapeDriveQuery(name)}'`);
  return clauses.join(" and ");
}

export function parseFileMeta(raw: unknown): CloudFile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id : undefined;
  const name = typeof v.name === "string" ? v.name : undefined;
  if (!id || !name) return undefined;
  const mimeType = typeof v.mimeType === "string" ? v.mimeType : undefined;
  const parents = Array.isArray(v.parents) ? v.parents : [];
  return {
    id,
    name,
    isFolder: mimeType === FOLDER_MIME,
    // Drive reports size as a string, because it can exceed 2^53.
    size: typeof v.size === "string" ? Number(v.size) || undefined : undefined,
    rev: typeof v.headRevisionId === "string" ? v.headRevisionId : undefined,
    hash: typeof v.md5Checksum === "string" ? v.md5Checksum : undefined,
    modifiedAt:
      typeof v.modifiedTime === "string" ? Date.parse(v.modifiedTime) || undefined : undefined,
    parentId: typeof parents[0] === "string" ? parents[0] : undefined,
  };
}

export interface DriveListPage {
  files: CloudFile[];
  nextPageToken?: string;
}

/** Drops Google-native documents; keeps folders and real binary files. */
export function parseFileList(raw: unknown): DriveListPage {
  const v = (raw ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(v.files) ? v.files : [];
  const files: CloudFile[] = [];
  for (const entry of entries) {
    const mimeType = (entry as Record<string, unknown> | null)?.mimeType;
    if (isGoogleNative(typeof mimeType === "string" ? mimeType : undefined)) continue;
    const file = parseFileMeta(entry);
    if (file) files.push(file);
  }
  return {
    files,
    nextPageToken: typeof v.nextPageToken === "string" ? v.nextPageToken : undefined,
  };
}

/** `about?fields=user(...)` — the label the Settings menu shows. */
export function parseAboutUser(raw: unknown): CloudAccount | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const user = (raw as Record<string, unknown>).user;
  if (!user || typeof user !== "object") return undefined;
  const v = user as Record<string, unknown>;
  const email = typeof v.emailAddress === "string" ? v.emailAddress : undefined;
  const id = typeof v.permissionId === "string" ? v.permissionId : email;
  if (!id) return undefined;
  const display = typeof v.displayName === "string" ? v.displayName : undefined;
  return { id, label: email ?? display ?? id };
}
