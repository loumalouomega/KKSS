/** Real Jobs renderer + real MCP transport, no solver or provider credentials. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchApp, appWindow, closeApp, root } from "./e2eShared.mjs";
async function until(check) {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${check}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function jobsScenario(screenshot) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-jobs-e2e-"));
  const stateFile = path.join(temporary, "jobs.json");
  const state = { jobs: [{ job_id: "cantilever-001", case_dir: "/examples/structural/cantilever", parameters_file: "ProjectParameters.json", created_at: 1720000000, started_at: 1720000000, state: "running" }] };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const bin = path.join(temporary, "bin"); fs.mkdirSync(bin);
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, "uvx"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "tools/fixtures/jobs-server.mjs"))} "$@"\n`, { mode: 0o755 });
  const { app } = await launchApp(undefined, { userDataDir: path.join(temporary, "profile") });
  try {
    await app.evaluate((_electron, { bin, stateFile }) => {
      process.env.PATH = bin + ":" + process.env.PATH;
      process.env.KKSS_JOBS_FIXTURE = stateFile;
    }, { bin, stateFile });
    const shell = await appWindow(app, "/renderer/shell/", Date.now() + 60_000);
    await shell.evaluate(() => window.shellApi.post({ type: "setMode", mode: "cad" }));
    await shell.locator("#jobs-btn").click();
    const jobs = await appWindow(app, "/renderer/jobs/", Date.now() + 60_000);
    await until(async () => await jobs.locator(".job").count() === 1);
    await until(async () => await shell.locator("#jobs-btn").textContent() === "Jobs (1)");
    await jobs.locator(".job").click();
    await until(async () => (await jobs.locator("#log").textContent()).includes("Residual < 1e-5"));
    await jobs.locator("h1").hover();
    if (screenshot) await jobs.screenshot({ path: screenshot });
    await shell.locator("#chat-btn").click();
    await appWindow(app, "/renderer/chat/", Date.now() + 60_000);
    await until(async () => await shell.locator("#jobs-btn").getAttribute("aria-pressed") === "false");
    await shell.locator("#jobs-btn").click();
    await until(async () => (await jobs.locator("#log").textContent()).includes("STEP: 12"));
    await jobs.reload();
    await until(async () => await jobs.locator("#selected-id").textContent() === "cantilever-001");
    // Foreign renderer IPC cannot cancel a job.
    await shell.evaluate(() => window.shellApi.post({ type: "cancel", jobId: "cantilever-001" }));
    if (JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs[0].state !== "running") throw new Error("Foreign cancellation accepted");
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, disconnect: true }));
    await jobs.locator("#refresh").click();
    await until(async () => (await jobs.locator("#status").textContent()).includes("last known state"));
    await jobs.locator("#recovery").waitFor({ state: "visible" });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    await jobs.locator("#recovery").click();
    await jobs.locator("#recovery").waitFor({ state: "hidden" });
    await until(async () => !(await jobs.locator("#status").textContent()).includes("last known state"));
    // Narrow window + every supported scale: controls remain reachable.
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setSize(720, 600));
    for (const factor of [0.75, 0.9, 1, 1.1, 1.25, 1.5]) {
      await shell.selectOption("#zoom-select", String(factor));
      await jobs.locator("#cancel").scrollIntoViewIfNeeded();
      const overflow = await jobs.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (overflow) throw new Error(`Jobs panel overflows at ${factor}`);
    }
    await jobs.locator("#cancel").focus();
    await jobs.keyboard.press("Enter");
    await until(async () => (await jobs.locator(".state").textContent()).includes("cancelled"));
    await until(async () => await shell.locator("#jobs-btn").textContent() === "Jobs");
    await jobs.keyboard.press("Escape");
    await until(async () => await shell.locator("#jobs-btn").getAttribute("aria-pressed") === "false");
    console.log("Jobs: discovery, logs, sidebar switching, reload, cancellation, reconnect and layout passed");
  } finally { await closeApp(app); fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await jobsScenario(path.join(root, "doc/public/screenshots/kratos-jobs.png"));
}
