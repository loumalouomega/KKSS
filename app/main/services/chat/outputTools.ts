/**
 * `app__messages_tail` — read-class view of the Output panel for the assistant:
 * the last Messages or Log entries, or what is running/finished on the Progress
 * tab. Nothing here writes, and the text was scrubbed of credential-shaped
 * tokens when it entered the buffers (outputCore.ts).
 */
import type { AppTool } from "./appTools";
import { messageLog, outputLog, progress } from "../outputBus";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function outputTools(): AppTool[] {
  return [{
    name: "app__messages_tail",
    description:
      "Read the application's Output panel: the latest entries of its Messages tab (what happened: files opened, solver and queue outcomes, errors), " +
      "its Log tab (raw console warnings/errors and solver output) or its Progress tab (running and recently finished operations). " +
      "Read-only. Use it to find out what a solver or a meshing run reported, or whether something is still running.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string", enum: ["messages", "log", "progress"], description: "Which tab to read (default messages)." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Newest entries to return (default ${DEFAULT_LIMIT}).` },
        level: { type: "string", enum: ["info", "warn", "error"], description: "Messages/Log only: keep this level." },
      },
      additionalProperties: false,
    },
    invoke: async (args) => {
      const tab = args.tab === "log" || args.tab === "progress" ? args.tab : "messages";
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : DEFAULT_LIMIT));
      if (tab === "progress") {
        const items = progress.snapshot().slice(-limit).map((i) => ({
          source: i.source, label: i.label, state: i.state, percent: i.fraction === null ? null : Math.round(i.fraction * 100),
          ...(i.detail ? { detail: i.detail } : {}),
        }));
        return { tab, running: progress.activeCount, items };
      }
      const level = args.level === "info" || args.level === "warn" || args.level === "error" ? args.level : undefined;
      const entries = (tab === "log" ? outputLog : messageLog).snapshot().filter((e) => !level || e.level === level).slice(-limit);
      return { tab, entries: entries.map((e) => ({ at: e.at, level: e.level, source: e.source, text: e.text })) };
    },
  }];
}
