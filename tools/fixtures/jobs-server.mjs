/** Deterministic stdio MCP fixture. Also answers the runtime's uvx probe. */
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
if (process.argv.includes("--version")) { console.log("uvx 0.11.0"); process.exit(0); }
const file = process.env.KKSS_JOBS_FIXTURE;
if (!file) throw new Error("Fixture state file required");
const server = new McpServer({ name: "Kratos jobs fixture", version: "0.3.0" });
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
function respond(value) { return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: Array.isArray(value) ? { result: value } : value }; }
for (const name of ["job_list", "job_status", "job_logs", "job_cancel"]) {
  server.registerTool(name, { inputSchema: { job_id: z.string().optional(), tail: z.number().optional() } }, async ({ job_id }) => {
    const state = read();
    if (state.disconnect) { process.exit(0); }
    const job = state.jobs.find((j) => j.job_id === job_id);
    if (name === "job_list") return respond(state.jobs);
    if (!job) return respond({ error: "Unknown job" });
    if (name === "job_status") return respond({ ...job, elapsed_seconds: 24, progress: { current_step: 12, current_time: 0.12 } });
    if (name === "job_logs") return respond({ job_id, log: "Cantilever — structural analysis\nSTEP: 12\nTIME: 0.12\nConvergence achieved\nResidual < 1e-5" });
    job.state = "cancelled"; job.finished_at = 1720000024;
    fs.writeFileSync(file, JSON.stringify(state));
    return respond(job);
  });
}
await server.connect(new StdioServerTransport());
