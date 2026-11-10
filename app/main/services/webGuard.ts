import { app, session, shell } from "electron";
import { eventLog } from "./eventLog";
import { allowNavigation, externalOpen, permissionAllowed } from "./webGuardCore";

let installed = false;

/**
 * The floor under every view and dialog window: navigation stays on the app's
 * own schemes, `window.open` reaches the OS browser for web/mail links only,
 * and a permission request is denied unless webGuardCore lists it. Handlers set
 * by individual services (manual, plot panel, static report) run first or are
 * stricter, and this adds nothing they could weaken. Refusals go to the event
 * log, so they show up in Help ▸ Export Diagnostics.
 */
export function installWebGuard(): void {
  if (installed) return;
  installed = true;

  app.on("web-contents-created", (_event, contents) => {
    const manual = () => contents.getURL().startsWith("kkss://docs");
    contents.on("will-navigate", (event, url) => {
      if (allowNavigation(url, { docsView: manual() })) return;
      event.preventDefault();
      eventLog.log("warn", [`Blocked navigation to ${scrub(url)}`]);
    });
    // Services that need something narrower (plots, static report) call
    // setWindowOpenHandler themselves after creation, which replaces this one.
    contents.setWindowOpenHandler(({ url }) => {
      if (externalOpen(url)) void shell.openExternal(url);
      else eventLog.log("warn", [`Blocked window.open to ${scrub(url)}`]);
      return { action: "deny" };
    });
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = permissionAllowed(permission);
    if (!ok) eventLog.log("warn", [`Denied permission request: ${permission}`]);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
}

/** URLs can carry file paths or tokens; keep the scheme and host only. */
function scrub(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(unparseable url)";
  }
}
