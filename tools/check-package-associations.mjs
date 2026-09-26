#!/usr/bin/env node
/** Checks that electron-builder's native associations cover the same formats
 * as the two source routers. This deliberately reads source registries rather
 * than maintaining a third list of extensions. */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

import { readRoutingRegistry, checkFormatDocumentation } from "./format-registry.mjs";
const { counts, suffixes } = readRoutingRegistry();
for (const file of ["doc/index.md", "doc/guide/file-formats.md", "doc/guide/getting-started.md"]) {
  checkFormatDocumentation(readFileSync(file, "utf8"), counts, file);
}
console.log(`Extended formats: ${counts.read} readable / ${counts.write} writable (${counts.readExtensions.length} read suffixes / ${counts.writeExtensions.length} write suffixes).`);
const config = yaml.load(readFileSync("electron-builder.yml", "utf8"));
const packaged = new Set((config.fileAssociations ?? []).map(({ ext }) => String(ext).replace(/^\./, "")));
const missing = [...suffixes].filter(ext => !packaged.has(ext)).sort();
const extra = [...packaged].filter(ext => !suffixes.has(ext)).sort();
if (missing.length || extra.length) {
  console.error(JSON.stringify({ missing, extra }, null, 2));
  process.exit(1);
}
console.log(`Package associations cover ${suffixes.size} routed extensions.`);
