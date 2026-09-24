import { t } from "../../shared/i18n";
import type { ChatServerStatus } from "../../main/ipc";

/** Readable Kratos recovery state shared by rendering and regression tests. */
export function kratosStatusView(servers: ChatServerStatus[]) {
  const server = servers.find((s) => s.key === "kratos");
  if (!server || server.state === "ready") return null;
  if (server.state === "starting") return {
    text: server.phase === "installing" ? t("Installing uv for KKSS…")
      : server.phase === "probing" ? t("Checking the Kratos runtime…") : t("Preparing Kratos tools…"),
    action: null,
  };
  const install = server.failure === "missing-runtime" || server.failure === "runtime";
  return {
    text: server.error || t("Kratos tools are unavailable. Retry to reconnect."),
    action: install ? "installKratosRuntime" as const : "retryKratos" as const,
  };
}
