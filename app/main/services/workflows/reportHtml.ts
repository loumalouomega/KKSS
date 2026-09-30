/** Escape every data cell; exports contain no executable script or network assets. */
export function escape(value: unknown): string {
  const text = value === null || value === undefined ? 'unavailable' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function table(title: string, headers: string[], rows: unknown[][]): string {
  return `<h2>${escape(title)}</h2><table><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">unavailable</td></tr>`}</tbody></table>`;
}
export function jsonTwin(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return `<details><summary>Machine-readable JSON</summary><pre>${escape(json)}</pre></details><script type="application/json" id="report-data">${json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>`;
}
