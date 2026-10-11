/**
 * The preconfigured PDF reader: `pdf-insight-mcp` from PyPI, launched through the
 * same uv the Kratos server uses (`uvx --with "mcp<2" pdf-insight-mcp@<v>`).
 *
 * Pinned like `KRATOS_MCP_VERSION`: the tool list is classified in
 * `toolPolicy.ts` against this exact release, so a bump is a reviewed edit
 * (`PDF_TOOLS_REVIEWED_VERSION` there must move with it). The package is MIT; it
 * depends on PyMuPDF (AGPL-3.0), which is launched as a separate process and
 * never bundled into the installer — compatible with KKSS's own AGPL-3.0-or-later.
 */
export const PDF_MCP_PACKAGE = "pdf-insight-mcp";
export const PDF_MCP_VERSION = "0.2.1";
