/**
 * Files on another machine, over the system `ssh` binary.
 *
 * Using the user's own client keeps `~/.ssh/config`, the agent, keys,
 * `ProxyJump` and known-hosts handling authoritative, and adds no dependency.
 * KKSS never sees a password or passphrase: `BatchMode=yes` makes ssh fail
 * rather than prompt, so a host must already be reachable non-interactively.
 *
 * One provider serves every host: the host rides in the item id
 * (`host:/abs/path`, see `providerCore/sshCore.ts`) and in `CloudRef.accountId`.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CloudError, type CloudAccount, type CloudFile } from "../cloudCore";
import type { CloudProvider, ListPage, TransferOptions } from "../cloudProvider";
import {
  decodeId,
  downloadCommand,
  encodeId,
  fileFromStat,
  joinRemote,
  listCommand,
  mkdirCommand,
  parseList,
  parseStat,
  sshArgs,
  statCommand,
  uploadCommand,
} from "../providerCore/sshCore";

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshRunOptions {
  /** Local file piped to the remote command's stdin. */
  stdinFile?: string;
  /** Local file the remote command's stdout is written to (via a temp name). */
  stdoutFile?: string;
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
}

export type SshRunner = (host: string, command: string, options?: SshRunOptions) => Promise<SshResult>;

/** Failure classification shared with the Kratos startup banner's wording. */
export function classifySshFailure(stderr: string): CloudError["kind"] {
  if (/permission denied|host key verification failed|authentication/i.test(stderr)) return "auth";
  if (/no such file|not a directory/i.test(stderr)) return "notFound";
  if (/could not resolve|connection (refused|timed out|closed|reset)|no route|network is unreachable|timed out/i.test(stderr)) {
    return "network";
  }
  return "other";
}

export const spawnSsh: SshRunner = (host, command, options = {}) =>
  new Promise<SshResult>((resolve, reject) => {
    const child = spawn("ssh", sshArgs(host, command), { stdio: ["pipe", "pipe", "pipe"] });
    const tmp = options.stdoutFile ? `${options.stdoutFile}.download` : undefined;
    const sink = tmp ? fs.createWriteStream(tmp) : undefined;
    let stdout = "";
    let stderr = "";
    let done = 0;
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 8192) stderr += d.toString("utf8");
    });
    if (sink) {
      child.stdout.on("data", (d: Buffer) => {
        done += d.length;
        options.onProgress?.(done);
      });
      child.stdout.pipe(sink);
    } else {
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
    }
    if (options.stdinFile) {
      const input = fs.createReadStream(options.stdinFile);
      input.on("error", () => child.kill("SIGTERM"));
      input.pipe(child.stdin);
      child.stdin.on("error", () => undefined);
    } else {
      child.stdin.end();
    }

    const finish = async (code: number) => {
      options.signal?.removeEventListener("abort", abort);
      if (sink && tmp) {
        await new Promise<void>((r) => (sink.writableFinished ? r() : sink.once("finish", () => r())));
        if (code === 0 && options.stdoutFile) await fs.promises.rename(tmp, options.stdoutFile);
        else await fs.promises.rm(tmp, { force: true });
      }
      resolve({ code, stdout, stderr });
    };
    child.on("error", (err) => {
      options.signal?.removeEventListener("abort", abort);
      sink?.destroy();
      reject(new CloudError("other", `Could not run ssh: ${err.message}`, err));
    });
    child.on("close", (code) => {
      void finish(code ?? 1);
    });
  });

export class SshProvider implements CloudProvider {
  readonly id = "ssh" as const;
  readonly label = "SSH";
  readonly needsClientSecret = false;

  constructor(private readonly run: SshRunner = spawnSsh) {}

  account(): CloudAccount {
    return { id: "ssh", label: "SSH" };
  }
  isConnected(): boolean {
    return true;
  }
  async connect(): Promise<CloudAccount> {
    return this.account();
  }
  async disconnect(): Promise<void> {}

  private async exec(host: string, command: string, options?: SshRunOptions): Promise<SshResult> {
    const result = await this.run(host, command, options);
    if (result.code !== 0) {
      const detail = result.stderr.trim().slice(0, 300);
      throw new CloudError(
        classifySshFailure(result.stderr),
        `ssh ${host} failed (${result.code})${detail ? `: ${detail}` : ""}`
      );
    }
    return result;
  }

  async list(folderId: string | undefined): Promise<ListPage> {
    const { host, path: dir } = decodeId(folderId ?? "");
    const result = await this.exec(host, listCommand(dir));
    return { files: parseList(host, result.stdout).files };
  }

  /** The resolved absolute directory behind a (possibly empty-path) folder id. */
  async resolveDir(folderId: string): Promise<string> {
    const { host, path: dir } = decodeId(folderId);
    const result = await this.exec(host, listCommand(dir));
    return encodeId(host, parseList(host, result.stdout).dir);
  }

  async stat(fileId: string): Promise<CloudFile> {
    const { host, path: p } = decodeId(fileId);
    const result = await this.exec(host, statCommand(p));
    const info = parseStat(result.stdout);
    if (!info) throw new CloudError("other", `Unexpected stat output from ${host}.`);
    return fileFromStat(host, p, info);
  }

  async findChild(parentId: string, name: string): Promise<CloudFile | undefined> {
    const { host, path: dir } = decodeId(parentId);
    try {
      return await this.stat(encodeId(host, joinRemote(dir, name)));
    } catch (err) {
      // A failed stat is "absent" only when ssh itself got through.
      if (err instanceof CloudError && err.kind === "other") return undefined;
      if (err instanceof CloudError && err.kind === "notFound") return undefined;
      throw err;
    }
  }

  async download(file: CloudFile, destPath: string, options: TransferOptions = {}): Promise<void> {
    const { host, path: p } = decodeId(file.id);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await this.exec(host, downloadCommand(p), {
      stdoutFile: destPath,
      signal: options.signal,
      onProgress: (done) => options.onProgress?.(done, file.size),
    });
  }

  async upload(fileId: string, localPath: string, options: TransferOptions = {}): Promise<CloudFile> {
    const { host, path: p } = decodeId(fileId);
    await this.exec(host, uploadCommand(p), { stdinFile: localPath, signal: options.signal });
    return this.stat(fileId);
  }

  async create(
    parentId: string,
    name: string,
    localPath: string,
    options: TransferOptions = {}
  ): Promise<CloudFile> {
    const { host, path: dir } = decodeId(parentId);
    return this.upload(encodeId(host, joinRemote(dir, name)), localPath, options);
  }

  async ensureFolder(parentId: string, name: string): Promise<CloudFile> {
    const { host, path: dir } = decodeId(parentId);
    const target = encodeId(host, joinRemote(dir, name));
    const existing = await this.findChild(parentId, name);
    if (existing) {
      if (!existing.isFolder) throw new CloudError("conflict", `${name} exists and is not a folder.`);
      return existing;
    }
    await this.exec(host, mkdirCommand(joinRemote(dir, name)));
    return this.stat(target);
  }
}
