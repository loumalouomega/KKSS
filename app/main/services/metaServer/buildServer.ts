/**
 * Wires one aggregated McpManager (via the shared McpHub) behind a low-level MCP
 * `Server`. The low-level Server (not the high-level McpServer) is used because
 * McpManager already holds tools as raw JSON Schema — we forward ListTools /
 * CallTool verbatim (preserving image/structured content that the chat path
 * flattens) and re-expose resources & prompts natively.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpHub } from "../chat/mcpHub";

export function buildMetaServer(hub: McpHub, version: string): Server {
  const server = new Server(
    { name: "kkss", version },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const mgr = hub.ensureStarted();
    return {
      tools: mgr.tools().map((t) => ({
        name: t.name,
        description: t.description,
        // inputSchema always originates from a real MCP tool (type: "object").
        inputSchema: t.inputSchema as Tool["inputSchema"],
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const mgr = hub.ensureStarted();
    return mgr.callToolRaw(req.params.name, req.params.arguments ?? {});
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const mgr = hub.ensureStarted();
    return { resources: await mgr.listResources() };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const mgr = hub.ensureStarted();
    return mgr.readResource(req.params.uri);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const mgr = hub.ensureStarted();
    return { prompts: await mgr.listPrompts() };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const mgr = hub.ensureStarted();
    return mgr.getPrompt(req.params.name, (req.params.arguments as Record<string, string>) ?? {});
  });

  return server;
}
