import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));
const { checkRemoteEnvironment } = await import("../app/main/services/workflows/environment");
import type { SshRunner } from "../app/main/services/cloud/providers/ssh";

const probe = (extra: object = {}) => `noise\nKKSS_PROBE:${JSON.stringify({
  executable: "/usr/bin/python3", version: "3.12.1", threadControl: true,
  applications: [{ name: "KratosMultiphysics", available: true }], ...extra })}\n`;
const fake = (o: { cpus?: string; python?: { code: number; stdout: string; stderr?: string }; mkdir?: number } = {}): SshRunner & { calls: string[] } => {
  const calls: string[] = [];
  const run = (async (_host: string, command: string) => {
    calls.push(command);
    if (command.startsWith("python3 ")) return { stderr: "", ...(o.python ?? { code: 0, stdout: probe() }) };
    if (command.startsWith("nproc")) return { code: 0, stdout: o.cpus ?? "8\n", stderr: "" };
    if (command.startsWith("mkdir")) return { code: o.mkdir ?? 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  }) as SshRunner & { calls: string[] };
  run.calls = calls;
  return run;
};
const base = { host: "hpc", applications: ["KratosMultiphysics.StructuralMechanicsApplication"], requirementsComplete: true };

describe("checkRemoteEnvironment", () => {
  it("describes the host: CPUs, thread control and a writable run directory", async () => {
    const ssh = fake();
    const report = await checkRemoteEnvironment({ ...base, ssh });
    expect(report).toMatchObject({ host: "hpc", cpuCount: 8, suggestedThreads: 7, writable: true, directory: "hpc:kkss-runs" });
    expect(report.manual).toMatchObject({ available: true, modes: ["output", "terminal"] });
    expect(report.manual.capabilities).toMatchObject({ threads: true, mpi: false });
    expect(report.tools.available).toBe(false);
    expect(report.tools.reason).toMatch(/remote host/);
  });
  it("reports a missing Kratos application with the interpreter's reason", async () => {
    const ssh = fake({ python: { code: 0, stdout: probe({ applications: [{ name: "KratosMultiphysics", available: false, reason: "No module named 'KratosMultiphysics'" }] }) } });
    const report = await checkRemoteEnvironment({ ...base, ssh });
    expect(report.manual.available).toBe(false);
    expect(report.suggestedThreads).toBeUndefined();
  });
  it("fails closed when python3 errors or the CPU count is unreadable", async () => {
    const broken = await checkRemoteEnvironment({ ...base, ssh: fake({ python: { code: 127, stdout: "", stderr: "python3: not found" } }) });
    expect(broken.manual.available).toBe(false);
    expect(broken.manual.reason).toMatch(/python3 on hpc failed: python3: not found/);
    const noCpu = await checkRemoteEnvironment({ ...base, ssh: fake({ cpus: "lots" }) });
    expect(noCpu.cpuCount).toBe(0);
    expect(noCpu.manual.available).toBe(false);
    expect(noCpu.manual.reason).toMatch(/CPU count/);
  });
  it("marks an uncreatable run directory unwritable", async () => {
    const report = await checkRemoteEnvironment({ ...base, ssh: fake({ mkdir: 1 }) });
    expect(report.writable).toBe(false);
    expect(report.directoryReason).toMatch(/hpc/);
  });
  it("keeps untrusted application names out of the remote command line", async () => {
    const report = await checkRemoteEnvironment({ ...base, applications: ["x; rm -rf ~"], ssh: fake() });
    expect(report.manual.available).toBe(false);
    expect(report.manual.reason).toMatch(/Invalid Kratos application name/);
  });
});
