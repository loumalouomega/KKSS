/**
 * Files the user attaches to a chat message — validation, the stored-size
 * budget, and which providers may receive them.
 *
 * Pure module (no electron/node imports) so the glue tests drive it directly and
 * `transcriptStoreCore.ts` / `transcript.ts` can share it.
 *
 * Two kinds. Images are re-encoded and downscaled by the sidebar before they are
 * sent; PDFs are not (there is nothing to shrink losslessly), so an oversize PDF
 * is refused with the reason rather than altered.
 *
 * Unlike a tool-result image — session-only, because the model never sees the
 * bytes — an attachment *is* the model's input, so it is stored with the
 * conversation. That is why every limit here is a hard cap with a defined
 * eviction: the transcript file is rewritten whole on each save.
 */
import type {
  ChatAttachment,
  ChatAttachmentInput,
  ChatAttachmentKind,
  ChatAttachmentRefusal,
} from "../../ipc";

export const IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const PDF_MIME_TYPE = "application/pdf";

/** Standard base64, no whitespace or URL-safe alphabet — this string is
 *  interpolated into a data: URL by the renderer, and an MCP server is not a
 *  trusted source. */
export const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Limits are on the base64 *string* length — what is stored and cloned. */
export const MAX_IMAGE_B64 = 2 * 1024 * 1024;
/** ≈ 5 MiB of PDF bytes; Anthropic's own request ceiling is far above this. */
export const MAX_PDF_B64 = 7 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_PDFS_PER_MESSAGE = 3;
/** Total base64 held by one conversation; the oldest message's files are evicted
 *  past it. Larger than any single message can be, so a send never evicts itself. */
export const CONVERSATION_ATTACHMENT_BUDGET = 16 * 1024 * 1024;
export const MAX_NAME_CHARS = 200;

export function kindOfMime(mimeType: string): ChatAttachmentKind | null {
  if (mimeType === PDF_MIME_TYPE) return "pdf";
  return IMAGE_MIME_TYPES.includes(mimeType) ? "image" : null;
}

/** `%PDF-` — checked on the first six decoded bytes, so a renamed text file
 *  cannot reach the provider as a "PDF" and come back as an opaque 400. */
function looksLikePdf(base64: string): boolean {
  try {
    return atob(base64.slice(0, 8)).startsWith("%PDF-");
  } catch {
    return false;
  }
}

/** Why a single attachment is unusable, or `null` when it is fine. */
export function attachmentProblem(kind: ChatAttachmentKind | null, mimeType: string, dataBase64: unknown): string | null {
  if (!kind) return `unsupported file type ${mimeType || "(unknown)"}`;
  if (typeof dataBase64 !== "string" || !dataBase64) return "empty file";
  const cap = kind === "pdf" ? MAX_PDF_B64 : MAX_IMAGE_B64;
  if (dataBase64.length > cap) return kind === "pdf" ? "PDF is larger than 5 MB" : "image is too large";
  if (!BASE64_RE.test(dataBase64)) return "file data is not valid base64";
  if (kind === "pdf" && !looksLikePdf(dataBase64)) return "file is not a PDF";
  return null;
}

function cleanName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const trimmed = name.replace(/[\u0000-\u001f]/g, "").trim();
  return trimmed ? trimmed.slice(0, MAX_NAME_CHARS) : undefined;
}

export type ValidatedAttachments =
  | { ok: true; attachments: Array<Omit<ChatAttachment, "id">> }
  | { ok: false; detail: string };

/**
 * The renderer is not trusted with shape: this runs on every `send`.
 * All-or-nothing — a message that silently lost one of its files would be a
 * different question than the user asked.
 */
export function validateAttachments(raw: unknown): ValidatedAttachments {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return { ok: false, detail: "attachments must be a list" };
  const out: Array<Omit<ChatAttachment, "id">> = [];
  let images = 0;
  let pdfs = 0;
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") return { ok: false, detail: "malformed attachment" };
    const { mimeType, dataBase64, name } = item as Partial<ChatAttachmentInput>;
    const mime = typeof mimeType === "string" ? mimeType : "";
    const kind = kindOfMime(mime);
    const problem = attachmentProblem(kind, mime, dataBase64);
    if (problem) return { ok: false, detail: problem };
    if (kind === "pdf") pdfs++;
    else images++;
    out.push({ kind: kind!, mimeType: mime, dataBase64: dataBase64 as string, ...(cleanName(name) ? { name: cleanName(name) } : {}) });
  }
  if (images > MAX_IMAGES_PER_MESSAGE) return { ok: false, detail: `at most ${MAX_IMAGES_PER_MESSAGE} images per message` };
  if (pdfs > MAX_PDFS_PER_MESSAGE) return { ok: false, detail: `at most ${MAX_PDFS_PER_MESSAGE} PDFs per message` };
  return { ok: true, attachments: out };
}

/** One stored attachment off disk, or `undefined` if unusable. A damaged file
 *  costs that file, never the message that carried it. */
export function parseStoredAttachment(raw: unknown): ChatAttachment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.mimeType !== "string") return undefined;
  const kind = kindOfMime(r.mimeType);
  if (attachmentProblem(kind, r.mimeType, r.dataBase64)) return undefined;
  const name = cleanName(r.name);
  return { id: r.id, kind: kind!, mimeType: r.mimeType, dataBase64: r.dataBase64 as string, ...(name ? { name } : {}) };
}

export function attachmentBytes(attachments: readonly ChatAttachment[] | undefined): number {
  let total = 0;
  for (const a of attachments ?? []) total += a.dataBase64.length;
  return total;
}

interface UserLike {
  kind: string;
  attachments?: ChatAttachment[];
  attachmentsEvicted?: number;
}

/**
 * Evicts the files of the oldest messages until the conversation is within
 * `cap`. Whole-message granularity: half the files of a message would answer a
 * different question than the one asked. Mutates — it is applied once, at append
 * time, to the live conversation — and returns how many files were dropped.
 * The newest message is never touched, so a send cannot evict itself.
 */
export function enforceAttachmentBudget(entries: UserLike[], cap = CONVERSATION_ATTACHMENT_BUDGET): number {
  let total = 0;
  for (const e of entries) total += attachmentBytes(e.attachments);
  let dropped = 0;
  let lastWithFiles = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "user" && entries[i].attachments?.length) {
      lastWithFiles = i;
      break;
    }
  }
  for (let i = 0; i < entries.length && total > cap && i < lastWithFiles; i++) {
    const e = entries[i];
    if (e.kind !== "user" || !e.attachments?.length) continue;
    total -= attachmentBytes(e.attachments);
    dropped += e.attachments.length;
    e.attachmentsEvicted = (e.attachmentsEvicted ?? 0) + e.attachments.length;
    delete e.attachments;
  }
  return dropped;
}

/** The text that stands in for files a request cannot carry. */
export function omittedNote(attachments: readonly ChatAttachment[], why: string): string {
  const images = attachments.filter((a) => a.kind === "image").length;
  const pdfs = attachments.length - images;
  const parts: string[] = [];
  if (images) parts.push(`${images} image${images === 1 ? "" : "s"}`);
  if (pdfs) parts.push(`${pdfs} PDF${pdfs === 1 ? "" : "s"}`);
  return `[${parts.join(" and ")} attached here ${why}]`;
}

/**
 * Whether `provider` can receive an attachment of `kind` — the single decision
 * point, used for the composer state, the `send` gate, and the per-request
 * history guard.
 *
 * Anthropic takes both natively. The OpenAI-compatible family has no portable
 * PDF wire format, so a PDF is refused there with a pointer to the PDF tools,
 * and an image needs the user's opt-in because KKSS cannot know whether a
 * gateway's model has vision. The subscription runtimes take text only.
 */
export function attachmentSupport(
  provider: string,
  kind: ChatAttachmentKind,
  imageInputEnabled: boolean
): ChatAttachmentRefusal | null {
  if (provider === "codex" || provider === "claude-code") return "subscription";
  if (provider === "anthropic") return null;
  if (kind === "pdf") return "pdfNeedsMcp";
  return imageInputEnabled ? null : "gatewayOptIn";
}

/** A copy of `entries` with every file the provider cannot carry replaced by a
 *  text note. Allocates; never mutates (the stored record keeps the files). */
export function withoutUnsupported<T extends { kind: string; text?: string; attachments?: ChatAttachment[] }>(
  entries: T[],
  supported: (kind: ChatAttachmentKind) => boolean,
  why: string
): T[] {
  return entries.map((entry) => {
    if (entry.kind !== "user" || !entry.attachments?.length) return entry;
    const dropped = entry.attachments.filter((a) => !supported(a.kind));
    if (!dropped.length) return entry;
    const kept = entry.attachments.filter((a) => supported(a.kind));
    const text = `${entry.text ?? ""}${entry.text ? "\n\n" : ""}${omittedNote(dropped, why)}`;
    const copy: T = { ...entry, text };
    if (kept.length) copy.attachments = kept;
    else delete copy.attachments;
    return copy;
  });
}

/** Request-shaping for a context overflow with nothing left to clear: keep only
 *  the newest message's files. Copy, never mutation. */
export function onlyNewestAttachments<T extends { kind: string; text?: string; attachments?: ChatAttachment[] }>(
  entries: T[]
): T[] {
  let newest = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === "user" && entries[i].attachments?.length) {
      newest = i;
      break;
    }
  }
  return entries.map((entry, i) => {
    if (i === newest || entry.kind !== "user" || !entry.attachments?.length) return entry;
    const text = `${entry.text ?? ""}${entry.text ? "\n\n" : ""}${omittedNote(entry.attachments, "earlier were left out to fit the context window")}`;
    const copy: T = { ...entry, text };
    delete copy.attachments;
    return copy;
  });
}
