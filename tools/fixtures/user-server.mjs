/**
 * A user-configured stdio MCP server for the MCP-manager acceptance scenario.
 * `argv[2]`, when given, is a log file: one line per start and per tool call, so
 * the scenario can prove what was (and was never) launched or run.
 */
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const log = (line) => { if (process.argv[2]) fs.appendFileSync(process.argv[2], `${line}\n`); };
log("start");
const server = new McpServer({ name: "User fixture", version: "1.0.0" });
for (const name of ["lookup", "wipe"]) {
  server.registerTool(name, { description: `Fixture tool ${name}`, inputSchema: {} }, async () => {
    log(`call:${name}`);
    return { content: [{ type: "text", text: name === "lookup" ? "found it" : "wiped" }] };
  });
}
await server.connect(new StdioServerTransport());
