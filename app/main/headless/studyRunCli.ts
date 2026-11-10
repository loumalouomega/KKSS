/**
 * Electron glue for `kkss --headless study run`. It builds the
 * one real `WorkflowService` over a lean dependency set — no window, no chat, no
 * stored settings of its own — and hands `runStudy` a view of it. It reads the
 * Kratos runtime settings from a saved state file and never writes any state, so
 * it can run beside a live KKSS without sharing its profile.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { KratosRuntime } from "../services/chat/kratosRuntime";
import { McpHub, waitForServers } from "../services/chat/mcpHub";
import { WorkflowService } from "../services/workflows/service";
import { EXIT, runStudy, type CliOptions, type HeadlessWorkflow, type StudyRunReport } from "./studyRunCore";
import { environmentFromSettings, loadSettings } from "./studyRunSettings";

/** Runs the command and returns the process exit code; the caller exits. */
export async function runHeadlessStudyCli(options: CliOptions, outDir: string): Promise<number> {
  const root = path.resolve(options.project);
  const emit = (report: StudyRunReport): number => {
    const text = JSON.stringify(report, null, 2) + "\n";
    process.stdout.write(text);
    if (options.output) { try { fs.writeFileSync(options.output, text); } catch (error) { console.error(`Could not write ${options.output}: ${(error as Error).message}`); } }
    return report.exitCode;
  };
  if (!fs.existsSync(path.join(root, ".kkss", "project.json"))) {
    return emit({ version: 1, project: root, outcome: "error", exitCode: EXIT.usage, started: false, message: "The project folder holds no KKSS project (.kkss/project.json).", tasks: [], runs: [] });
  }
  const environment = environmentFromSettings(loadSettings(options.settings), { python: options.python });
  // Only the servers a queued plan uses: preparation tasks go through cad and mesh, solves through mesh.
  const hub = new McpHub(outDir, undefined, ["cad", "mesh"]);
  const workflows = new WorkflowService({
    root: () => root,
    activeMesh: () => undefined,
    runtime: new KratosRuntime(app.getPath("userData")),
    environment: () => environment,
    open: async () => undefined,
    changed: () => undefined,
    callMcpTool: (name, args) => hub.ensureStarted().callToolRaw(name, args),
    remote: () => undefined, // ssh solves are a GUI-session feature for now
    toolReady: (key) => hub.statuses().some((s) => s.key === key && s.state === "ready"),
    prepareQueue: () => waitForServers(hub, ["cad", "mesh"]),
  });
  const tools = new Map(workflows.tools().map((t) => [t.name, t]));
  const workflow: HeadlessWorkflow = {
    snapshot: () => workflows.snapshot(),
    async call(tool, args) {
      const entry = tools.get(`app__${tool}`);
      if (!entry) throw new Error(`Unknown workflow tool ${tool}.`);
      return entry.invoke(args);
    },
  };
  try {
    const report = await runStudy(workflow, options, { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    return emit(report);
  } catch (error) {
    return emit({ version: 1, project: root, outcome: "error", exitCode: EXIT.failed, started: false, message: (error as Error).message, tasks: [], runs: [] });
  } finally {
    await hub.dispose().catch(() => undefined);
  }
}
