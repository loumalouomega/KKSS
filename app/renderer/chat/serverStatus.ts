import type { ChatServerStatus } from "../../main/ipc";

/** Readable Kratos recovery state shared by rendering and regression tests. */
export function kratosStatusView(servers: ChatServerStatus[]) {
  const server = servers.find((s) => s.key === "kratos");
  if (!server || server.state === "ready") return null;
  if (server.state === "starting") return {
    text: server.phase === "installing" ? "Installing uv for KKSS…"
      : server.phase === "probing" ? "Checking the Kratos runtime…" : "Preparing Kratos tools…",
    action: null,
  };
  const install = server.failure === "missing-runtime" || server.failure === "runtime";
  return {
    text: server.error || "Kratos tools are unavailable. Retry to reconnect.",
    action: install ? "installKratosRuntime" as const : "retryKratos" as const,
  };
}
