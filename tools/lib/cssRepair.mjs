// Repairs ONE class of defect in a submodule stylesheet we cannot edit: a rule
// whose closing brace is missing. CSS nesting then swallows every following
// rule (mesh 5.39.0's `.pt-flash` took the whole ribbon block with it).
//
// Heuristic, deliberately narrow: an *unindented* line ending in `{` is a
// top-level rule start in these files (nested rules are indented). If we see
// one while still inside an open block, the block was never closed, so a `}` is
// inserted right after the last declaration seen. Balanced input is returned
// byte-identical, which makes this a no-op once upstream fixes the stylesheet.

/** Strip comments and strings to spaces, keeping offsets and newlines. */
function mask(css) {
  const out = css.split("");
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (let k = i; k < stop; k++) if (out[k] !== "\n") out[k] = " ";
      i = stop;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < css.length && css[k] !== c && css[k] !== "\n") k += css[k] === "\\" ? 2 : 1;
      for (let j = i + 1; j < Math.min(k, css.length); j++) if (out[j] !== "\n") out[j] = " ";
      i = k + 1;
    } else i++;
  }
  return out.join("");
}

/**
 * @param {string} css
 * @returns {{css: string, repaired: {line: number, selector: string}[]}}
 */
export function repairUnbalancedCss(css) {
  const masked = mask(css);
  const inserts = []; // {at, selector, line}
  let depth = 0;
  let lastDecl = -1; // offset just after the last `;` at the current open block
  let openSelector = "";
  let openLine = 0;
  let lineNo = 1;
  let lineStart = 0;
  for (let i = 0; i <= masked.length; i++) {
    const c = masked[i];
    if (c === "\n" || i === masked.length) {
      const line = masked.slice(lineStart, i);
      if (depth >= 1 && lastDecl >= 0 && /^[^\s}@][^;{}]*\{\s*$/.test(line)) {
        inserts.push({ at: lastDecl, selector: openSelector, line: openLine });
        depth = 0;
        lastDecl = -1;
      }
      if (c === "\n") {
        lineNo++;
        lineStart = i + 1;
        // Re-scan this line's braces below, so count from lineStart.
      }
    }
    if (c === "{") {
      if (depth === 0) {
        openSelector = masked.slice(Math.max(0, masked.lastIndexOf("}", i - 1) + 1), i).trim().split("\n").pop().trim();
        openLine = lineNo;
        lastDecl = -1;
      }
      depth++;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      lastDecl = -1;
    } else if (c === ";" && depth >= 1) lastDecl = i + 1;
  }
  if (!inserts.length) return { css, repaired: [] };
  let result = css;
  for (const ins of [...inserts].reverse()) result = result.slice(0, ins.at) + "\n}" + result.slice(ins.at);
  return { css: result, repaired: inserts.map((x) => ({ line: x.line, selector: x.selector })) };
}
