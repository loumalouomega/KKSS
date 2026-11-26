import { Notification } from "electron";
import { t } from "../../shared/i18n";
import { shouldShow, type Notice } from "./osNotifyCore";

/**
 * Shows a short allow-list of events as operating-system notifications while the
 * window is not focused. Clicking one focuses the window. Nothing is transmitted
 * or stored; `KKSS_E2E` suppresses them.
 */
export function osNotify(notice: Notice, deps: { enabled: () => boolean; focused: () => boolean; focus: () => void }): void {
  if (!shouldShow(deps.enabled(), deps.focused(), Boolean(process.env.KKSS_E2E)) || !Notification.isSupported()) return;
  const n = new Notification({ title: t(notice.title as never), body: notice.body, silent: notice.kind === "info" });
  n.on("click", deps.focus);
  n.show();
}
