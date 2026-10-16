// Shared by case generation, solver verification, documentation and UI captures.
const assignment = (conditionId, smpPath, values = {}) => ({ conditionId, smpPath, values });
const material = (smpPath, lawId, values) => ({ smpPath, lawId, values });

// Mok benchmark (Mok 2001, Valdés 2007; Kratos's fsi_mok validation case) in
// millimetres. The convergent ramp in the source case has no analytic
// definition — its boundary mesh is the geometry — so it is drawn through 28
// stations read off that boundary, each within 0.01 mm of it.
const mokRamp = [
  [505.000, 0.000], [533.140, 11.360], [563.990, 23.800], [593.140, 35.560],
  [622.630, 47.460], [651.430, 59.080], [684.090, 72.260], [714.760, 84.640],
  [749.090, 98.490], [779.600, 110.800], [813.220, 124.370], [849.920, 139.180],
  [877.790, 150.420], [905.660, 161.670], [933.530, 172.910], [961.400, 184.160],
  [989.270, 195.400], [1017.150, 206.650], [1045.020, 217.900], [1072.890, 229.140],
  [1100.760, 240.390], [1128.630, 251.630], [1156.500, 262.880], [1193.700, 276.440],
  [1232.000, 286.930], [1270.900, 294.530], [1310.300, 298.810], [1350.000, 300.000],
];
// Channel boundary counterclockwise: bottom-left along the base to the wall
// slot, up and over the slot, down and along the ramp, then the flat bottom
// at y = 300, the outlet riser, the slip top and the inlet side. Edge ids
// follow this order: 0 base, 1/2/3 the slot, 4..30 the ramp, 31 flat bottom,
// 32 outlet, 33 top, 34 inlet; the wall's bottom line added next is 35.
const mokFluid = [[0, 0], [500, 0], [500, 250], [505, 250], ...mokRamp, [1750, 300], [1750, 500], [0, 500]];
const mokPoints = mokFluid.map(([x, y]) => [x, y, 0]);

export const cases = [
  {
    id: 'structural', title: 'Structural cantilever', problemtype: 'structural',
    source: 'cad/examples/STP/block.stp', geometry: 'cantilever.stp',
    ops: [{ op: 'scale', targets: ['solid-0'], center: [0, 0, 0], factors: [6, 1, 1] }],
    parts: [{ name: 'Solid', volumes: ['solid-0'] }, { name: 'Support', surfaces: ['face-3'] }, { name: 'Load', surfaces: ['face-1'] }],
    options: { dimension: 3, sizeMin: 0.8, sizeMax: 0.8 },
    problem: { analysisType: 'non_linear', endTime: 1, timeStep: 0.125 },
    assignments: [assignment('parts', 'Solid'), assignment('displacement', 'Support', { value: [0, 0, 0], constrained: true }), assignment('surfacePressure', 'Load', { value: 100000 })],
    materials: [material('Solid', 'linear_elastic_3d', { DENSITY: 7850, YOUNG_MODULUS: 210000000000, POISSON_RATIO: 0.3 })],
    field: 'DISPLACEMENT',
  },
  {
    id: 'fluid', title: 'Laminar flow around an obstacle', problemtype: 'fluid', planar: true, planarGeometry: 'obstacle',
    obstacle: { widthMm: 2000, heightMm: 600, centerMm: [500, 300], radiusMm: 60, sides: 32 },
    problem: { timeStep: 0.1, endTime: 5, echoLevel: 0, maxIterations: 20 },
    assignments: [assignment('parts', 'Domain'), assignment('inlet', 'Inlet', { modulus: 0.1, direction: 'x' }), assignment('outlet', 'Outlet', { value: 0 }), assignment('slip', 'Walls'), assignment('noSlip', 'Obstacle')],
    materials: [material('Domain', 'newtonian_2d', { DENSITY: 1000, DYNAMIC_VISCOSITY: 0.6 })], field: 'VELOCITY',
  },
  {
    id: 'thermal', title: 'Stationary heat conduction', problemtype: 'convectionDiffusion',
    source: 'cad/examples/STP/block.stp', geometry: 'body.stp', ops: [],
    parts: [{ name: 'Domain', volumes: ['solid-0'] }, { name: 'Cold', surfaces: ['face-3'] }, { name: 'Hot', surfaces: ['face-5'] }],
    options: { dimension: 3, sizeMin: 0.8, sizeMax: 0.8 },
    problem: { solverType: 'stationary', timeStep: 1, endTime: 1 },
    assignments: [assignment('parts', 'Domain'), assignment('temperature', 'Cold', { value: 300 }), assignment('temperature', 'Hot', { value: 400 })],
    materials: [material('Domain', 'thermal', { DENSITY: 1000, CONDUCTIVITY: 1, SPECIFIC_HEAT: 1000 })], field: 'TEMPERATURE',
  },
  {
    id: 'potential-flow', title: 'Uniform potential flow', problemtype: 'potentialFlow', planar: true,
    problem: { formulation: 'incompressible', echoLevel: 1 },
    assignments: [assignment('parts', 'Domain'), assignment('farField', 'Boundary', { angleOfAttack: 0, machInfinity: 0.03, speedOfSound: 340 })],
    materials: [], field: 'VELOCITY_POTENTIAL',
  },
  {
    id: 'shallow-water', title: 'Still-water basin', problemtype: 'shallowWater', planar: true,
    problem: { timeStep: 0.015625, endTime: 0.125, gravity: 9.81 },
    assignments: [assignment('parts', 'Domain'), assignment('topography', 'Domain', { value: '0.0' }), assignment('initialWaterLevel', 'Domain', { variable: 'HEIGHT', value: 1 }), assignment('slip', 'Boundary')],
    materials: [material('Domain', 'manning', { MANNING: 0.01 })], field: 'HEIGHT',
  },
  {
    // The Kratos validation case fsi_mok: a channel whose convergent lower
    // wall carries an elastic wall (500..505 x 0..250, clamped at its base)
    // that the flow bends. Fluid 956 kg/m3, 0.145 Pa s; wall plane stress,
    // E = 2.3 MPa, nu = 0.45, unit thickness; dt 0.1 s, 25 s; the two-phase
    // inlet ramps with the Dijkstra-style parabola until t = 10 s and holds
    // until the end. Two planar faces in mm: the fluid region (the channel
    // with the wall's slot cut out of its bottom) and the wall itself. The
    // wall loop is drawn counterclockwise like the fluid one — the CAD op
    // materialises its own copies of the slot edges where the traversal runs
    // against them — and the conformal surface fragment merges the coincident
    // boundaries at mesh time, so one shared Interface Part serves both
    // solvers (the 3D cases' pattern).
    id: 'fsi', title: 'Fluid-structure interaction (Mok benchmark)', problemtype: 'fsi', mok: true,
    source: 'cad/examples/BREP/blank.brep',
    geometry: 'mok-channel.brep',
    ops: [
      { op: 'addPolyline', points: mokPoints, closed: true },
      { op: 'addLine', start: [500, 0, 0], end: [505, 0, 0] },
      { op: 'addSurfaceFromLines', edges: mokFluid.map((_, n) => `edge-${n}`) },
      { op: 'addSurfaceFromLines', edges: [`edge-${mokFluid.length}`, 'edge-3', 'edge-2', 'edge-1'] },
    ],
    options: { dimension: 2, sizeMin: 2, sizeMax: 40 },
    // Section-keyed solver values merged into the problemtype defaults (fsi:
    // problem/fluid/structure), as published with the case: monolithic vms
    // Bossak fluid, non-linear dynamic Bossak structure with total Lagrangian
    // elements, MVQN coupling to 1e-8 within 25 iterations.
    values: {
      problem: { endTime: 25, nlTol: 1e-8, nlMaxIt: 25, couplingStrategy: 'MVQN' },
      fluid: {
        // dt = 0.05 s: at dt = 0.1 s the structure Newton stops converging at
        // t ≈ 4 s on this Kratos build (the upstream Kratos-7.0 reference ran
        // dt = 0.1 s to 25 s; its own files diverge here too, at t ≈ 6.7 s),
        // while dt = 0.05 s converges every step — the documented case setup.
        f_elementType: 'vms', f_timeScheme: 'bossak', f_dynamicTau: 1.0, f_timeStep: 0.05,
        f_maxIterations: 20, f_relVelTol: 1e-8, f_absVelTol: 1e-10, f_relPresTol: 1e-8, f_absPresTol: 1e-10,
        // The structure takes the fluid REACTION as its interface load.
        f_computeReactions: true, f_echoLevel: 0,
      },
      structure: {
        s_solverType: 'dynamic', s_analysisType: 'non_linear', s_elementBase: 'TotalLagrangianElement',
        s_schemeType: 'bossak', s_convergenceCriterion: 'residual_criterion', s_maxIteration: 20,
        s_residualRelTol: 1e-8, s_residualAbsTol: 1e-10, s_echoLevel: 0,
      },
    },
    assignments: [
      assignment('f_parts', 'Fluid'),
      assignment('f_inlet', 'Inlet', { modulus: 0.0607, modulusExpression: '0.1214*(1-cos(0.1*pi*t))*y*(1-y)', intervalStart: 0, intervalEnd: '10' }),
      assignment('f_inlet', 'Inlet', { modulus: 0.0607, modulusExpression: '0.2428*y*(1-y)', intervalStart: 10, intervalEnd: 'End' }),
      assignment('f_outlet', 'Outlet', { value: 0 }),
      assignment('f_noSlip', 'Walls'),
      assignment('f_slip', 'Slip'),
      assignment('fluidInterface', 'Interface'),
      // Every outer boundary holds the ALE mesh; only the wall interface moves.
      assignment('aleMeshBC', 'Inlet'), assignment('aleMeshBC', 'Outlet'),
      assignment('aleMeshBC', 'Walls'), assignment('aleMeshBC', 'Slip'),
      assignment('s_parts', 'Structure'),
      assignment('s_displacement', 'Fixed', { value: [0, 0, 0], constrained: true }),
      assignment('structureInterface', 'Interface'),
    ],
    materials: [
      material('Fluid', 'newtonian_2d', { DENSITY: 956, DYNAMIC_VISCOSITY: 0.145 }),
      material('Structure', 'linear_elastic_plane_stress', { DENSITY: 1500, YOUNG_MODULUS: 2300000, POISSON_RATIO: 0.45, THICKNESS: 1.0 }),
    ],
    field: 'VELOCITY', structureField: 'DISPLACEMENT', benchmark: true, timeout: 7200000,
    // Every 10 steps (0.5 s) keeps the 25 s run's output browsable while the
    // tip's 9.5 s peak stays resolved.
    output: { interval: 10 },
    // Captures: the wall's centimetre-scale bend needs no warp (1× keeps the
    // deflected shape in frame), and the manual capture replays the full 25 s
    // solve inside the app, so it gets the full solver budget too.
    warp: 1, manualTimeout: 7200000,
  },
  {
    id: 'cosim', title: 'Partitioned coupling (weak CoSimulation with ALE)', problemtype: 'cosim', coupled3d: true,
    coupled: { widthMm: 2000, fluidHeightMm: 600, solidHeightMm: 50, depthMm: 100 },
    source: 'cad/examples/BREP/blank.brep',
    geometry: 'coupled-channel.brep',
    ops: [
      { op: 'addBox', center: [1000, 300, 50], size: [2000, 600, 100] },
      { op: 'addBox', center: [1000, -25, 50], size: [2000, 50, 100] },
    ],
    options: { dimension: 3, sizeMin: 100, sizeMax: 100 },
    // cosim sections are coupling/fluid/structure. Weak coupling exchanges
    // data once per step (no criterion to converge); ALE moves the fluid mesh.
    // Strong coupling is the same case with couplingType strong (needs ALE).
    values: {
      coupling: { couplingType: 'weak', aleMesh: true, mapperType: 'nearest_element', endTime: 0.15 },
      // Bossak: this Kratos branch segfaults in BDF2 Predict on 3D monolithic
      // fluid (verified live); Bossak runs cleanly and stays monolithic.
      // Compute reactions: the structure pulls the fluid REACTION as its load —
      // without this the coupling transfers zero force (user-facing:
      // the sidebar exposes it as a fluid checkbox; coupled generation could
      // force it on upstream).
      fluid: { f_timeStep: 0.05, f_echoLevel: 0, f_timeScheme: 'bossak', f_computeReactions: true },
      structure: {
        // Dynamic non-linear like Mok: a linear analysis assembles once and
        // never sees the per-step transferred POINT_LOAD; non-linear rebuilds
        // every iteration. Bossak dodges this branch's broken BDF2 Predict.
        s_solverType: 'dynamic', s_schemeType: 'bossak', s_analysisType: 'non_linear',
      },
    },
    assignments: [
      assignment('f_parts', 'Fluid'),
      assignment('f_inlet', 'Inlet', { modulus: 0.1, direction: 'x' }),
      assignment('f_outlet', 'Outlet', { value: 0 }),
      assignment('f_slip', 'Walls'),
      assignment('fluidInterface', 'Interface'),
      assignment('aleMeshBC', 'Inlet'), assignment('aleMeshBC', 'Outlet'), assignment('aleMeshBC', 'Walls'),
      assignment('s_parts', 'Structure'),
      assignment('s_displacement', 'Fixed', { value: [0, 0, 0], constrained: true }),
      assignment('structureInterface', 'Interface'),
    ],
    materials: [
      material('Fluid', 'newtonian_3d', { DENSITY: 1000, DYNAMIC_VISCOSITY: 0.6 }),
      material('Structure', 'linear_elastic_3d', { DENSITY: 1000, YOUNG_MODULUS: 500000000, POISSON_RATIO: 0.3 }),
    ],
    field: 'VELOCITY', structureField: 'DISPLACEMENT',
    driver: 'MainKratosCoSim.py', primaryDocument: 'ProjectParametersCoSim.json', benchmark: false, timeout: 600000,
  },
].map(c => !c.planar ? c : {
  ...c,
  source: 'cad/examples/BREP/blank.brep',
  geometry: c.planarGeometry === 'obstacle' ? 'obstacle-channel.brep' : 'rectangle.brep',
  ops: c.planarGeometry === 'obstacle'
    ? [
      { op: 'addPolyline', points: [[0, 0, 0], [c.obstacle.widthMm, 0, 0], [c.obstacle.widthMm, c.obstacle.heightMm, 0], [0, c.obstacle.heightMm, 0]], closed: true },
      { op: 'addPolyline', points: Array.from({ length: c.obstacle.sides }, (_, i) => {
        // The outer boundary is counter-clockwise; reverse the obstacle loop
        // so the hole's skin conditions inherit the fluid-outward normal.
        const angle = -2 * Math.PI * i / c.obstacle.sides;
        return [c.obstacle.centerMm[0] + c.obstacle.radiusMm * Math.cos(angle), c.obstacle.centerMm[1] + c.obstacle.radiusMm * Math.sin(angle), 0];
      }), closed: true },
    ]
    : [{ op: 'addRectangleProfile', center: [2000, 500, 0], normal: [0, 0, 1], up: [1, 0, 0], width: 4000, height: 1000 }],
  options: c.planarGeometry === 'obstacle'
    ? { dimension: 2, sizeMin: 15, sizeMax: 70 }
    : { dimension: 2, sizeMin: 200, sizeMax: 200 },
});
