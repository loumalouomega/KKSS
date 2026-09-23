/** App-owned tools share the same services as IPC; no extra MCP process. */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDef } from './providers/types';
export interface AppTool extends ToolDef { invoke(args: Record<string, unknown>): Promise<unknown> }
let registered: AppTool[] = [];
export function registerAppTools(tools: AppTool[]): void {
  if (new Set(tools.map(t => t.name)).size !== tools.length || tools.some(t => !t.name.startsWith('app__'))) throw new Error('Invalid app tool registry.');
  registered = tools;
}
export function appTools(): ToolDef[] { return registered.map(({ invoke: _, ...definition }) => definition); }
export async function callAppTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const tool = registered.find(t => t.name === name);
    if (!tool) throw new Error(`Unknown app tool: ${name}`);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object.');
    const value = await tool.invoke(args);
    return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }; }
}
