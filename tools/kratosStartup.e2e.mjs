/** Real renderer recovery check, reused by the documentation generator. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { launchApp, appWindow, closeApp, root } from "./e2eShared.mjs";

export async function kratosStartupScenario(screenshot) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-startup-e2e-"));
  const { app } = await launchApp(undefined, { userDataDir: profile });
  try {
    // Remove uv from discovery without touching the user's actual environment.
    // Runtime discovery is lazy and starts only when the chat is opened.
    const originalPath = await app.evaluate(() => {
      const previous = process.env.PATH;
      process.env.PATH = "";
      return previous;
    });
    const shell = await appWindow(app, "/renderer/shell/", Date.now() + 60_000);
    await shell.locator("#chat-btn").click();
    const chat = await appWindow(app, "/renderer/chat/", Date.now() + 60_000);
    const install = chat.getByRole("button", { name: "Install uv for KKSS" });
    await install.waitFor({ state: "visible", timeout: 30_000 });
    if (!await chat.locator("#kratos-status").textContent().then((s) => s.includes("uv is not installed"))) throw new Error("Missing-runtime explanation absent");
    if (screenshot) await chat.screenshot({ path: screenshot });
    // Exercise an unfamiliar error through the real renderer and Retry IPC,
    // then return to the manager's actual missing-runtime state.
    await app.evaluate(({ webContents }) => {
      const target = webContents.getAllWebContents().find((w) => w.getURL().includes("/renderer/chat/"));
      target.send("chat:toWebview", { type: "servers", servers: [
        { key: "kratos", name: "Kratos", state: "unavailable", failure: "unknown", error: "Unexpected startup failure <not markup>" },
      ] });
    });
    await chat.getByRole("button", { name: "Retry", exact: true }).click();
    await install.waitFor({ state: "visible", timeout: 30_000 });
    await app.evaluate((_electron, previous) => { process.env.PATH = previous; }, originalPath);
    // With a system runtime now available, the stale install click must simply
    // reconnect. Without one, this explicit action exercises the real installer.
    await install.click();
    await chat.locator("#kratos-status").waitFor({ state: "hidden", timeout: 330_000 });
    if (await chat.locator(".server-dot.ready").count() !== 3) throw new Error("Recovery did not preserve all three servers");
    console.log("Kratos startup: missing-runtime explanation and live recovery passed");
  } finally {
    await closeApp(app);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await kratosStartupScenario(path.join(root, "doc/public/screenshots/chat-kratos-setup.png"));
}
