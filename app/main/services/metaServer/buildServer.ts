/**
 * Wires one aggregated McpManager (via the shared McpHub) behind a low-level MCP
 * `Server`. The low-level Server (not the high-level McpServer) is used because
 * McpManager already holds tools as raw JSON Schema — we forward ListTools /
 * CallTool verbatim (preserving structured content verbatim, where the chat
 * path flattens to text and forwards image blocks separately for display) and
 * re-expose resources & prompts natively.
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
import { metaDenialText, metaToolAllowed, type MetaAccessPolicy } from "./accessPolicy";

/** `policy` is read per request, so a Settings change applies to live sessions. */
export function buildMetaServer(hub: McpHub, version: string, policy: () => MetaAccessPolicy): Server {
  const server = new Server(
    { name: "kkss", version },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const mgr = hub.ensureStarted();
    return {
      tools: mgr.tools().filter((t) => metaToolAllowed(t.name, policy())).map((t) => ({
        name: t.name,
        description: t.description,
        // inputSchema always originates from a real MCP tool (type: "object").
        inputSchema: t.inputSchema as Tool["inputSchema"],
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Refused here, before the call reaches McpManager: an external client has no
    // user to prompt, so the setting is the only gate. An MCP error result, not
    // a silent no-op, so the client can tell the user why.
    const current = policy();
    if (!metaToolAllowed(req.params.name, current)) {
      return { isError: true, content: [{ type: "text", text: metaDenialText(req.params.name, current.access) }] };
    }
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
