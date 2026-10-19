// The generated parts of a tutorial page, rendered from data the solver
// verification already recorded. Pure: no filesystem, no Kratos. A page keeps
// its prose by hand and holds these islands between markers:
//
//   <!-- tutorial:glance:begin -->  ...generated...  <!-- tutorial:glance:end -->
//   <!-- tutorial:verified:begin --> ...generated...  <!-- tutorial:verified:end -->
//
// Only stable verification fields are read (python, kratos, sizes, frames, end
// time and checks), never files or revisions: those change on every publish
// and would make `writeDocs.mjs --check` fail for no reason.

export const ISLAND_NAMES = ['glance', 'verified'];

/** Kratos applications each tutorial imports, as the pip packages the tutorial runtime pins. */
export const KRATOS_PACKAGES = {
  structural: ['KratosStructuralMechanicsApplication'],
  eigen: ['KratosStructuralMechanicsApplication', 'KratosLinearSolversApplication'],
  fluid: ['KratosFluidDynamicsApplication'],
  rans: ['KratosRANSApplication', 'KratosLinearSolversApplication'],
  thermal: ['KratosConvectionDiffusionApplication'],
  'potential-flow': ['KratosCompressiblePotentialFlowApplication'],
  'shallow-water': ['KratosShallowWaterApplication'],
  fsi: ['KratosFSIApplication', 'KratosFluidDynamicsApplication', 'KratosStructuralMechanicsApplication', 'KratosMappingApplication', 'KratosMeshMovingApplication'],
  cosim: ['KratosCoSimulationApplication', 'KratosFluidDynamicsApplication', 'KratosStructuralMechanicsApplication', 'KratosMappingApplication', 'KratosMeshMovingApplication'],
  'wind-tunnel': ['KratosRANSApplication', 'KratosLinearSolversApplication'],
  'two-fluids': ['KratosFluidDynamicsApplication'],
};

/** The pinned version the tutorial runtime installs for every application. */
export const KRATOS_VERSION = '10.4.3';

/** Packages the docker runtime does not install yet; the page must say so. */
export const UNPINNED_PACKAGES = ['KratosFSIApplication', 'KratosCoSimulationApplication', 'KratosMappingApplication', 'KratosMeshMovingApplication'];

/** What the run wrote: VTK frames through an end time, or no VTK time series at all. */
export function outputText(report, { withTime = false } = {}) {
  if (!report.frames) return withTime ? 'no VTK time series' : ', no VTK time series';
  const frames = `${report.frames} frame${report.frames === 1 ? '' : 's'}`;
  if (!Number.isFinite(report.end_time)) return withTime ? frames : `, ${frames}`;
  return withTime ? `${frames}, end time ${report.end_time}` : `, ${frames} through t = ${report.end_time}`;
}

export const islandMarkers = (name) => ({
  begin: `<!-- tutorial:${name}:begin -->`,
  end: `<!-- tutorial:${name}:end -->`,
});

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toPrecision(7))) : String(value));

/** A check's limit as words: `≤ 0.001` or `≥ 2.5`; no limit recorded is blank. */
export function limitText(check) {
  if (check && typeof check === 'object' && 'maximum' in check) return `≤ ${number(check.maximum)}`;
  if (check && typeof check === 'object' && 'minimum' in check) return `≥ ${number(check.minimum)}`;
  return '';
}

/** The check rows of a verification record, in the record's own order. */
export function checkRows(checks = {}) {
  return Object.entries(checks).map(([name, value]) => {
    if (value && typeof value === 'object' && 'measured' in value) {
      return { name, measured: number(value.measured), limit: limitText(value) };
    }
    if (value && typeof value === 'object') return null;
    return { name, measured: number(value), limit: '' };
  }).filter(Boolean);
}

/**
 * The verification island: the environment that produced the numbers and the
 * checks the verifier applied to them.
 */
export function verifiedIsland(report) {
  const rows = checkRows(report.checks);
  const lines = [
    `Verified with Python ${report.python}, Kratos ${report.kratos}, ${report.threads ?? 2} OpenMP threads: ${report.nodes} nodes${report.elements ? ` and ${report.elements} cells` : ''}${outputText(report)}.`,
    '',
    '| Check | Measured | Limit |',
    '|---|---|---|',
    ...rows.map((row) => `| \`${cell(row.name)}\` | ${cell(row.measured)} | ${cell(row.limit)} |`),
    '',
    'These are tutorial checks with the tolerances shown, not formal solver certification.',
  ];
  return lines.join('\n');
}

/**
 * The glance island: the packages, mesh size and run length a reader needs
 * before starting, plus the download link.
 */
export function glanceIsland(report, { id, download }) {
  const packages = (KRATOS_PACKAGES[id] ?? []).map((name) => `\`${name}==${KRATOS_VERSION}\``);
  const unpinned = (KRATOS_PACKAGES[id] ?? []).filter((name) => UNPINNED_PACKAGES.includes(name));
  const rows = [
    ['Mesh', `${report.nodes} nodes${report.elements ? `, ${report.elements} cells` : ''}`],
    ['Run', outputText(report, { withTime: true })],
    ['Kratos packages', packages.join(', ') || 'Kratos core only'],
    ['Download', download ? `[${id} case with its verification record](${download})` : ''],
  ];
  const lines = [
    '| | |',
    '|---|---|',
    ...rows.filter(([, value]) => value).map(([label, value]) => `| ${label} | ${cell(value)} |`),
  ];
  if (unpinned.length) {
    lines.push('', `${unpinned.join(', ')} ${unpinned.length === 1 ? 'is' : 'are'} not in the docker runtime’s pinned requirements yet; install ${unpinned.length === 1 ? 'it' : 'them'} from the same Kratos ${KRATOS_VERSION} build.`);
  }
  return lines.join('\n');
}

/**
 * Replaces the body of one island. Throws when the markers are missing or
 * appear more than once, so an edit that deletes one cannot pass silently.
 */
export function replaceIsland(markdown, name, body) {
  const { begin, end } = islandMarkers(name);
  const starts = markdown.split(begin).length - 1;
  const ends = markdown.split(end).length - 1;
  if (starts !== 1 || ends !== 1) throw new Error(`island "${name}": expected one ${begin} and one ${end}, found ${starts} and ${ends}`);
  const from = markdown.indexOf(begin) + begin.length;
  const to = markdown.indexOf(end);
  if (to < from) throw new Error(`island "${name}": the end marker comes before the begin marker`);
  return `${markdown.slice(0, from)}\n${body}\n${markdown.slice(to)}`;
}

/** The island names a page holds, each once. */
export function islandsIn(markdown) {
  return ISLAND_NAMES.filter((name) => {
    const { begin } = islandMarkers(name);
    return markdown.includes(begin);
  });
}
