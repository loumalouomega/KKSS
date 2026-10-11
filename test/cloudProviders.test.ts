/**
 * Provider response parsing, against committed fixtures.
 *
 * These are the pure halves of the providers — everything checkable without a
 * live OAuth registration. The network call, the resumable upload against a
 * real endpoint and the consent round trip are manual; doc/guide/development.md
 * carries that checklist.
 */
import { describe, expect, it } from "vitest";
import { CloudError } from "../app/main/services/cloud/cloudCore";
import { ensureFolderVia } from "../app/main/services/cloud/providerCore/folderCore";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  apiArgHeader,
  dropboxParentOf,
  isConflictBody,
  parseAccountInfo,
  parseCreatedFolder,
  parseEntry,
  parseListFolder,
} from "../app/main/services/cloud/providerCore/dropboxCore";
import {
  childrenQuery,
  escapeDriveQuery,
  folderQuery,
  FOLDER_MIME,
  isGoogleNative,
  parseAboutUser,
  parseFileList,
} from "../app/main/services/cloud/providerCore/gdriveCore";
import {
  parseChildren,
  parseGraphUser,
  parseUploadSession,
} from "../app/main/services/cloud/providerCore/graphCore";

const fixture = (...parts: string[]): unknown =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "cloud", ...parts), "utf8"));

const isAscii = (text: string) => [...text].every((ch) => ch.charCodeAt(0) < 128);

describe("dropbox: list_folder", () => {
  const page = parseListFolder(fixture("dropbox", "list_folder.json"));

  it("keeps folders and files and drops tombstones", () => {
    // A ".tag": "deleted" entry is neither a file nor a folder — offering it in
    // the picker would produce a download that fails.
    expect(page.files.map((f) => f.name)).toEqual(["models", "bull.stp", "case.post.msh"]);
    expect(page.files[0].isFolder).toBe(true);
    expect(page.files[1].isFolder).toBe(false);
  });

  it("uses path_lower as the identity and derives the parent from it", () => {
    const bull = page.files[1];
    expect(bull.id).toBe("/kkss/bull.stp");
    expect(bull.parentId).toBe("/kkss");
  });

  it("reads rev, size and hash off a file but not a folder", () => {
    expect(page.files[1]).toMatchObject({ rev: "015f1e2a3b4c5d6", size: 482913, hash: "aa11bb22" });
    expect(page.files[0].rev).toBeUndefined();
    expect(page.files[1].modifiedAt).toBe(Date.parse("2026-09-01T10:15:00Z"));
  });

  it("surfaces the cursor only while more pages remain", () => {
    expect(page.cursor).toBe("AAEF_cursor_token");
    expect(page.hasMore).toBe(true);
    expect(parseListFolder({ entries: [], cursor: "c", has_more: false }).hasMore).toBe(false);
  });

  it("reads an empty or malformed body as an empty page", () => {
    expect(parseListFolder(undefined).files).toEqual([]);
    expect(parseListFolder({ entries: "nope" }).files).toEqual([]);
    expect(parseEntry({ ".tag": "file", name: "x" })).toBeUndefined();
  });
});

describe("dropboxParentOf", () => {
  it("returns the empty root for a top-level item", () => {
    expect(dropboxParentOf("/bull.stp")).toBe("");
    expect(dropboxParentOf("/a/b/bull.stp")).toBe("/a/b");
    expect(dropboxParentOf("")).toBe("");
  });
});

describe("apiArgHeader", () => {
  it("escapes every non-ASCII codepoint, because this travels in a header", () => {
    // The classic Dropbox bug: `pièce.stp` in a raw header is a 400 with an
    // opaque body. HTTP headers are ASCII; Dropbox unescapes \uXXXX for us.
    const header = apiArgHeader({ path: "/models/pièce.stp" });
    expect(header).toBe('{"path":"/models/pi\\u00e8ce.stp"}');
    expect(isAscii(header)).toBe(true);
    expect((JSON.parse(header) as { path: string }).path).toBe("/models/pièce.stp");
  });

  it("survives CJK and emoji, which are multi-byte or outside the BMP", () => {
    const header = apiArgHeader({ path: "/模型/case.post.msh" });
    expect(isAscii(header)).toBe(true);
    expect((JSON.parse(header) as { path: string }).path).toBe("/模型/case.post.msh");

    const emoji = apiArgHeader({ path: "/a/🐂.stp" });
    expect(isAscii(emoji)).toBe(true);
    // Surrogate pairs must survive as a pair, or the name comes back mojibake.
    expect((JSON.parse(emoji) as { path: string }).path).toBe("/a/🐂.stp");
  });

  it("leaves a plain ASCII argument byte-identical to JSON.stringify", () => {
    const arg = { path: "/a/b.stp", mode: { ".tag": "update", update: "r1" } };
    expect(apiArgHeader(arg)).toBe(JSON.stringify(arg));
  });
});

describe("parseAccountInfo", () => {
  it("prefers the email as the label the Settings menu shows", () => {
    expect(parseAccountInfo(fixture("dropbox", "account.json"))).toEqual({
      id: "dbid:AABBCC",
      label: "ada@example.com",
    });
  });

  it("falls back to the display name, then the id", () => {
    expect(parseAccountInfo({ account_id: "x", name: { display_name: "Ada" } })?.label).toBe("Ada");
    expect(parseAccountInfo({ account_id: "x" })?.label).toBe("x");
    expect(parseAccountInfo({})).toBeUndefined();
  });
});

describe("isConflictBody", () => {
  it("recognises the conditional-write rejection we asked for", () => {
    expect(isConflictBody('{"error_summary":"path/conflict/file/..","error":{".tag":"path"}}')).toBe(
      true
    );
    expect(isConflictBody('{"error_summary":"path/insufficient_space/.."}')).toBe(false);
  });
});

// ---------------------------------------------------------------- Google Drive

describe("gdrive: files.list", () => {
  const page = parseFileList(fixture("gdrive", "files_list.json"));

  it("drops Google-native documents, which have no binary content", () => {
    // `alt=media` answers 403 for a Doc/Sheet — offering one would produce a
    // download that always fails, so it never reaches the picker.
    expect(page.files.map((f) => f.name)).toEqual(["models", "bull.stp", "case.post.msh"]);
    expect(isGoogleNative("application/vnd.google-apps.document")).toBe(true);
    // A folder is also a google-apps mime type, and must NOT be filtered.
    expect(isGoogleNative(FOLDER_MIME)).toBe(false);
    expect(isGoogleNative("application/octet-stream")).toBe(false);
    expect(isGoogleNative(undefined)).toBe(false);
  });

  it("uses headRevisionId as the conflict baseline", () => {
    expect(page.files[1].rev).toBe("0B-rev-1");
    expect(page.files[1].hash).toBe("d41d8cd98f00b204e9800998ecf8427e");
    // Drive has no conditional media overwrite, so there is no precondition.
    expect(page.files[1].precondition).toBeUndefined();
  });

  it("converts Drive's string size to a number", () => {
    // Drive reports size as a string because it can exceed 2^53.
    expect(page.files[1].size).toBe(482913);
    expect(page.files[0].size).toBeUndefined();
  });

  it("carries the page token and the first parent", () => {
    expect(page.nextPageToken).toBe("TOKEN_PAGE_2");
    expect(page.files[1].parentId).toBe("root");
  });
});

describe("gdrive: query building", () => {
  it("escapes quotes and backslashes, which would otherwise be a 400", () => {
    // A model called O'Brien.stp is the everyday case that breaks a naive
    // template string.
    expect(childrenQuery("root", "O'Brien.stp")).toBe(
      "'root' in parents and trashed = false and name = 'O\\'Brien.stp'"
    );
    expect(escapeDriveQuery("a\\b")).toBe("a\\\\b");
    // Backslash first, then quote — the other order double-escapes.
    expect(escapeDriveQuery("a\\'b")).toBe("a\\\\\\'b");
  });

  it("omits the name clause when listing a whole folder", () => {
    expect(childrenQuery("folder1")).toBe("'folder1' in parents and trashed = false");
  });
});

describe("gdrive: parseAboutUser", () => {
  it("keys the account on permissionId and labels it with the email", () => {
    expect(parseAboutUser(fixture("gdrive", "about.json"))).toEqual({
      id: "1122334455",
      label: "ada@example.com",
    });
    expect(parseAboutUser({})).toBeUndefined();
  });
});

// ------------------------------------------------------------ OneDrive / Graph

describe("graph: children", () => {
  const page = parseChildren(fixture("graph", "children.json"));

  it("distinguishes a folder by the presence of the folder facet", () => {
    expect(page.files.map((f) => f.name)).toEqual(["models", "bull.stp"]);
    expect(page.files[0].isFolder).toBe(true);
    expect(page.files[1].isFolder).toBe(false);
  });

  it("uses cTag as the revision and eTag as the precondition — never the reverse", () => {
    // eTag moves on metadata-only edits (a rename, a shared link), so using it
    // as the sync baseline would manufacture a conflict copy every time
    // OneDrive touched the file for its own reasons.
    const bull = page.files[1];
    expect(bull.rev).toBe('"c:{GUID2},3"');
    expect(bull.precondition).toBe('"{GUID2},7"');
    expect(bull.rev).not.toBe(bull.precondition);
  });

  it("extracts the pre-authenticated download URL and the hash", () => {
    expect(page.files[1].downloadUrl).toBe("https://cdn.example.test/preauth/bull.stp?token=xyz");
    expect(page.files[1].hash).toBe("QXH123");
    expect(page.files[0].downloadUrl).toBeUndefined();
  });

  it("pages with a complete nextLink URL, not a bare token", () => {
    expect(page.nextLink).toContain("https://graph.microsoft.com/");
    expect(parseChildren({ value: [] }).nextLink).toBeUndefined();
  });

  it("reads parent, size and modified time", () => {
    expect(page.files[1]).toMatchObject({ parentId: "01ROOT", size: 482913 });
    expect(page.files[1].modifiedAt).toBe(Date.parse("2026-09-01T10:15:00Z"));
  });
});

describe("graph: identity and upload session", () => {
  it("prefers mail over the principal name for the account label", () => {
    expect(parseGraphUser(fixture("graph", "me.json"))).toEqual({
      id: "8f4a",
      label: "ada@example.com",
    });
    expect(parseGraphUser({ id: "x", userPrincipalName: "u@t" })?.label).toBe("u@t");
    expect(parseGraphUser({ displayName: "no id" })).toBeUndefined();
  });

  it("pulls the upload URL out of a createUploadSession response", () => {
    expect(parseUploadSession({ uploadUrl: "https://up.example.test/s1" })).toBe(
      "https://up.example.test/s1"
    );
    expect(parseUploadSession({})).toBeUndefined();
    expect(parseUploadSession(null)).toBeUndefined();
  });
});

describe("folder creation", () => {
  it("parses Dropbox's create_folder_v2 answer, which carries no .tag", () => {
    expect(
      parseCreatedFolder({ metadata: { name: "polyMesh", path_lower: "/kkss/constant/polymesh" } })
    ).toEqual({
      id: "/kkss/constant/polymesh",
      name: "polyMesh",
      isFolder: true,
      parentId: "/kkss/constant",
    });
    expect(parseCreatedFolder({})).toBeUndefined();
    expect(parseCreatedFolder(null)).toBeUndefined();
  });

  it("restricts Drive's name lookup to folders and keeps the quote escaping", () => {
    const q = folderQuery("p'1", "O'Brien");
    expect(q).toContain("'p\\'1' in parents");
    expect(q).toContain("name = 'O\\'Brien'");
    expect(q.endsWith(`mimeType = '${FOLDER_MIME}'`)).toBe(true);
  });

  describe("ensureFolderVia", () => {
    const folder = { id: "f", name: "constant", isFolder: true };
    const file = { id: "x", name: "constant", isFolder: false };

    it("returns an existing folder without creating one", async () => {
      let made = 0;
      const got = await ensureFolderVia({
        label: "Dropbox",
        name: "constant",
        find: async () => folder,
        make: async () => (made++, folder),
      });
      expect(got).toBe(folder);
      expect(made).toBe(0);
    });

    it("creates when absent", async () => {
      const got = await ensureFolderVia({
        label: "Dropbox",
        name: "constant",
        find: async () => undefined,
        make: async () => folder,
      });
      expect(got).toBe(folder);
    });

    it("re-finds after losing a creation race", async () => {
      let finds = 0;
      const got = await ensureFolderVia({
        label: "Dropbox",
        name: "constant",
        find: async () => (finds++ ? folder : undefined),
        make: async () => {
          throw new CloudError("conflict", "exists");
        },
      });
      expect(got).toBe(folder);
    });

    it("never replaces a file with a folder", async () => {
      await expect(
        ensureFolderVia({
          label: "Dropbox",
          name: "constant",
          find: async () => file,
          make: async () => folder,
        })
      ).rejects.toMatchObject({ kind: "conflict" });
    });

    it("rethrows a creation failure that is not a race", async () => {
      await expect(
        ensureFolderVia({
          label: "Dropbox",
          name: "constant",
          find: async () => undefined,
          make: async () => {
            throw new CloudError("quota", "full");
          },
        })
      ).rejects.toMatchObject({ kind: "quota" });
    });
  });
});
