// The screenshot and animation catalog for the geometry-to-results tutorials:
// one entry per file under doc/public/screenshots/. The pages cite these
// files, test/tutorialDocs.test.ts checks every reference against here, and
// the producers below write them.
//
//   manual     tools/tutorials/manual.mjs: CAD geometry, the Problemtype cards
//              after Generate (setup, setup-solver) and the exported mesh (mesh)
//   gallery    tools/tutorials/gallery.mjs: one field on the recovered frames
//   eigen      tools/tutorials/gallery.mjs: one mode shape of the GiD eigen result
//   fe-mesh    tools/tutorials/manual.mjs --fe-mesh: the CAD window after FE Mesh Generate
//   wizard     tools/tutorials/manual.mjs --wizard: one step of the virtual wind tunnel wizard
//   plot       tools/tutorials/gallery.mjs: a restored recipe, checked against its CSV
//   animation  tools/tutorials/animations.mjs: a GIF of one field over the steps
//   legacy     kept from the earlier generation and not regenerated yet
//
// Ranges are pinned from the data, so a series of frames shares one colour
// scale and the caption can state it. Nothing is pinned for a single frame
// unless the page needs the number.

const fieldShot = (caseId, name, field, extra = {}) => ({
  file: `tutorial-${caseId}-${name}.png`, case: caseId, producer: 'gallery', field, ...extra,
});
const plotShot = (caseId, name, recipe, extra = {}) => ({
  file: `tutorial-${caseId}-${name}.png`, case: caseId, producer: 'plot', recipe, ...extra,
});
const manualShot = (caseId, name, extra = {}) => ({
  file: `tutorial-${caseId}-${name}.png`, case: caseId, producer: 'manual', ...extra,
});
const gif = (caseId, name, field, extra = {}) => ({
  file: `tutorial-${caseId}-${name}.gif`, case: caseId, producer: 'animation', field, ...extra,
});
const legacy = (caseId, name, ext = 'png') => ({
  file: `tutorial-${caseId}-${name}.${ext}`, case: caseId, producer: 'legacy',
});
/**
 * One mode shape of the cantilever, shown Deformed by its own displacement field, with the tip moved tipMm and
 * coloured by the displacement magnitude. The source is the VTK copy that eigenModes.py writes from the raw GiD
 * records (gallery.mjs eigenShots writes it when it is missing); the viewer's own GiD reader is not used.
 */
const eigenShot = (caseId, name, field, extra = {}) => ({
  file: `tutorial-${caseId}-${name}.png`, case: caseId, producer: 'eigen', field, source: 'eigen-modes.vtu',
  view: 'front', zoomOut: 1, tipMm: 4.5, ...extra,
});
/** One step of the virtual wind tunnel wizard, shot in the mesh viewer (manual.mjs, windTunnelWizard). */
/** The CAD window after FE Mesh > Generate, framed (manual.mjs --fe-mesh). */
const feMeshShot = (caseId) => ({
  file: `tutorial-${caseId}-fe-mesh.png`, case: caseId, producer: 'fe-mesh',
});
const wizardShot = (caseId, name, step, extra = {}) => ({
  file: `tutorial-${caseId}-${name}.png`, case: caseId, producer: 'wizard', step, ...extra,
});

/** Every case: its CAD geometry and the setup cards once the case is generated. */
const setupShots = (caseId, { solver = true, mesh = true } = {}) => [
  manualShot(caseId, 'geometry'),
  manualShot(caseId, 'setup'),
  manualShot(caseId, 'setup-conditions'),
  ...(solver ? [manualShot(caseId, 'setup-solver')] : []),
  ...(mesh ? [manualShot(caseId, 'mesh')] : []),
];

export const CATALOG = [
  // ---- Turbulent flow around an obstacle (RANS k-epsilon) ----
  ...setupShots('rans'),
  fieldShot('rans', 'results', 'VELOCITY', { frame: 'last', view: 'front', bar: true }),
  fieldShot('rans', 'pressure', 'PRESSURE', { frame: 'last', range: [-0.61, 0.82], view: 'front', bar: true }),
  fieldShot('rans', 'tke', 'TURBULENT_KINETIC_ENERGY', { frame: 'last', range: [0, 3.4], view: 'front', bar: true }),
  fieldShot('rans', 'viscosity', 'TURBULENT_VISCOSITY', { frame: 'last', range: [0, 0.09], view: 'front', bar: true }),
  fieldShot('rans', 'dissipation', 'TURBULENT_ENERGY_DISSIPATION_RATE', { frame: 'last', range: [-7.9, 135.5], view: 'front', bar: true }),
  fieldShot('rans', 'wake-vectors', 'VELOCITY', { frame: 'last', modes: ['Quiver'], view: 'front', bar: true }),
  plotShot('rans', 'pressure-history', 'plots/pressure-history.json'),
  plotShot('rans', 'wake-profile', 'plots/wake-profile.json'),
  gif('rans', 'velocity', 'VELOCITY', { range: [0, 1.2] }),
  gif('rans', 'tke', 'TURBULENT_KINETIC_ENERGY', { range: [0, 3.4] }),

  // ---- Laminar flow around an obstacle ----
  ...setupShots('fluid'),
  fieldShot('fluid', 'results', 'VELOCITY', { frame: 'last', view: 'front', bar: true }),
  fieldShot('fluid', 'pressure', 'PRESSURE', { frame: 'last', view: 'front', bar: true }),
  fieldShot('fluid', 'vectors', 'VELOCITY', { frame: 'last', modes: ['Quiver'], view: 'front', bar: true }),
  plotShot('fluid', 'pressure-history', 'plots/pressure-history.json'),
  plotShot('fluid', 'wake-profile', 'plots/wake-profile.json'),
  gif('fluid', 'velocity', 'VELOCITY', { range: [0, 0.17] }),
  gif('fluid', 'pressure', 'PRESSURE', { range: [-10, 10], from: 5 }),

  // ---- Structural cantilever ----
  ...setupShots('structural'),
  fieldShot('structural', 'results', 'DISPLACEMENT', { frame: 'last', view: 'top', bar: true }),
  fieldShot('structural', 'stress-section', 'VON_MISES_STRESS', { frame: 'last', clip: { axis: 'y', pos: 0.5 }, view: 'top', bar: true }),
  plotShot('structural', 'displacement-history', 'plots/displacement-history.json'),
  plotShot('structural', 'reaction-history', 'plots/reaction-history.json'),
  legacy('structural', 'deformed'),
  legacy('structural', 'stress'),

  // ---- Eigenmodes of the same cantilever ----
  manualShot('eigen', 'geometry'),
  manualShot('eigen', 'setup'),
  manualShot('eigen', 'setup-solver'),
  manualShot('eigen', 'mesh'),
  // Mode shapes (eigenShot): mode 1 bends in y and is seen along z (front); mode 2 bends in z and is seen along
  // y (top); mode 3 is shown from the same front view as mode 1.
  eigenShot('eigen', 'mode-1', 'MODE1_DISPLACEMENT'),
  eigenShot('eigen', 'mode-2', 'MODE2_DISPLACEMENT', { view: 'top' }),
  eigenShot('eigen', 'mode-3', 'MODE3_DISPLACEMENT'),

  // ---- Thermal conduction ----
  ...setupShots('thermal'),
  fieldShot('thermal', 'results', 'TEMPERATURE', { frame: 'last', view: 'top', bar: true }),
  fieldShot('thermal', 'slice', 'TEMPERATURE', { frame: 'last', clip: { axis: 'y', pos: 0.5 }, view: 'top', bar: true }),
  plotShot('thermal', 'profile', 'plots/temperature-profile.json'),

  // ---- Potential flow ----
  ...setupShots('potential-flow'),
  fieldShot('potential-flow', 'results', 'VELOCITY_POTENTIAL', { frame: 'last', view: 'front', bar: true }),
  plotShot('potential-flow', 'profile', 'plots/potential-profile.json'),

  // ---- Shallow water ----
  ...setupShots('shallow-water'),
  plotShot('shallow-water', 'depth-history', 'plots/depth-history.json'),
  legacy('shallow-water', 'results'),

  // ---- Fluid-structure interaction (Mok benchmark) ----
  ...setupShots('fsi'),
  fieldShot('fsi', 'results', 'VELOCITY', { frame: 'last', view: 'front', bar: true }),
  fieldShot('fsi', 'pressure', 'PRESSURE', { frame: 'last', view: 'front', bar: true }),
  fieldShot('fsi', 'mesh-displacement', 'MESH_DISPLACEMENT', { frame: 'last', modes: ['Quiver'], view: 'front', bar: true }),
  plotShot('fsi', 'tip-displacement-history', 'plots/tip-displacement-history.json'),
  plotShot('fsi', 'pressure-history', 'plots/pressure-history.json'),
  gif('fsi', 'velocity', 'VELOCITY', { range: [0, 0.13] }),
  legacy('fsi', 'displacement', 'gif'),
  legacy('fsi', 'structure'),

  // ---- Partitioned coupling (weak CoSimulation) ----
  ...setupShots('cosim', { solver: true }),
  fieldShot('cosim', 'results', 'VELOCITY', { frame: 'last', view: 'front', bar: true }),
  fieldShot('cosim', 'pressure', 'PRESSURE', { frame: 'last', view: 'front', bar: true }),
  fieldShot('cosim', 'mesh-displacement', 'MESH_DISPLACEMENT', { frame: 'last', view: 'front', bar: true }),
  plotShot('cosim', 'interface-displacement-history', 'plots/interface-displacement-history.json'),
  plotShot('cosim', 'pressure-history', 'plots/pressure-history.json'),
  gif('cosim', 'velocity', 'VELOCITY', { range: [0, 0.15] }),
  legacy('cosim', 'displacement', 'gif'),
  legacy('cosim', 'structure'),

  // ---- Virtual wind tunnel (sphere, RANS k-omega SST) ----
  manualShot('wind-tunnel', 'geometry'),
  // Mid-plane (y = 0 is 0.5 of the extent) of the last recovered frame, seen along y; flipped so the cut face is the near one.
  fieldShot('wind-tunnel', 'velocity', 'VELOCITY', { frame: 'last', range: [0, 16], clip: { axis: 'y', pos: 0.5, flip: true }, view: 'top', bar: true, edges: false, zoomOut: 1 }),
  fieldShot('wind-tunnel', 'pressure', 'PRESSURE', { frame: 'last', range: [-75, 65], clip: { axis: 'y', pos: 0.5, flip: true }, view: 'top', bar: true, edges: false, zoomOut: 1 }),
  // The wizard's steps in the mesh viewer (manual.mjs --wizard). Step 5 is shot before and after Generate.
  wizardShot('wind-tunnel', 'wizard-body', 0),
  wizardShot('wind-tunnel', 'wizard-tunnel', 1),
  wizardShot('wind-tunnel', 'wizard-flow', 2),
  wizardShot('wind-tunnel', 'wizard-mesh', 3),
  wizardShot('wind-tunnel', 'wizard-plan', 4, { phase: 'plan' }),
  wizardShot('wind-tunnel', 'wizard-result', 4, { phase: 'result' }),

  // ---- Two-fluid dam break (level set) ----
  manualShot('two-fluids', 'geometry'),
  manualShot('two-fluids', 'setup'),
  manualShot('two-fluids', 'setup-solver'),
  // A 4:1 tank fits the whole canvas, so the mesh is zoomed out once more to keep both ends in frame.
  manualShot('two-fluids', 'mesh', { zoomOut: 2 }),
  // Frame 8 of the 20 recovered steps is file step 40, t = 0.2 s (steps 5..100 at 0.005 s).
  // zoomOut: the fitted tank runs under the Field panel, so the camera is pulled back until it clears the panel.
  fieldShot('two-fluids', 'velocity', 'VELOCITY', { frame: 'last', range: [0, 5], view: 'front', bar: true, zoomOut: 1 }),
  fieldShot('two-fluids', 'interface', 'DISTANCE', { frame: 8, range: [-0.5, 0.5], view: 'front', bar: true, zoomOut: 1 }),
  fieldShot('two-fluids', 'pressure', 'PRESSURE', { frame: 'last', range: [0, 8000], view: 'front', bar: true, zoomOut: 1 }),
  gif('two-fluids', 'interface', 'DISTANCE', { range: [-0.5, 0.5], stride: 1, zoomOut: 1 }),

  // ---- CAD-side FE mesh of every case (the geometry shots already show the Parts panel, so no separate parts shots) ----
  ...['structural', 'fluid', 'thermal', 'potential-flow', 'shallow-water', 'fsi', 'cosim', 'rans', 'eigen', 'two-fluids', 'wind-tunnel'].map(feMeshShot),
];

/** Entries for one tutorial, in catalog order. */
export const forCase = (caseId) => CATALOG.filter((shot) => shot.case === caseId);

/** The catalog's file names: one per entry, which must be unique. */
export const catalogFiles = () => CATALOG.map((shot) => shot.file);
