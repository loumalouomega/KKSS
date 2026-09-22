#!/usr/bin/env node
/** Checks that electron-builder's native associations cover the same formats
 * as the two source routers. This deliberately reads source registries rather
 * than maintaining a third list of extensions. */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const cad = readFileSync("cad/src/fileRouter.ts", "utf8");
const mesh = readFileSync("mesh/src/parser/meshioFormats.ts", "utf8");
const meshFormats = readFileSync("mesh/src/parser/meshFormats.ts", "utf8");
const cadBody = cad.match(/const EXTENSION_MAP:[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1] ?? "";
const meshBody = mesh.match(/MESHIO_READ_CANDIDATES:[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1] ?? "";
const nativeBody = meshFormats.match(/NATIVE_MESH_EXTENSIONS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1] ?? "";
const suffixes = new Set();
for (const line of cadBody.split("\n")) {
  const match = line.match(/^\s*"?([a-z0-9]+(?:\.[a-z0-9]+)*)"?\s*:/);
  if (match) suffixes.add(match[1]);
}
for (const match of meshBody.matchAll(/"(\.[a-z0-9]+(?:\.[a-z0-9]+)*)"\s*:/g)) suffixes.add(match[1].slice(1));
for (const match of nativeBody.matchAll(/"\.?([a-z0-9]+)"/g)) suffixes.add(match[1]);
const xmlBody = meshFormats.match(/VTK_XML_EXTENSIONS\s*= \[([\s\S]*?)\]/)?.[1] ?? "";
for (const match of xmlBody.matchAll(/"\.([a-z0-9]+)"/g)) suffixes.add(match[1]);
suffixes.add("mdpa");
const config = yaml.load(readFileSync("electron-builder.yml", "utf8"));
const packaged = new Set((config.fileAssociations ?? []).map(({ ext }) => String(ext).replace(/^\./, "")));
const missing = [...suffixes].filter(ext => !packaged.has(ext)).sort();
const extra = [...packaged].filter(ext => !suffixes.has(ext)).sort();
if (missing.length || extra.length) {
  console.error(JSON.stringify({ missing, extra }, null, 2));
  process.exit(1);
}
console.log(`Package associations cover ${suffixes.size} routed extensions.`);
