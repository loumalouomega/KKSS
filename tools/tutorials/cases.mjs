// Shared by case generation, solver verification, documentation and UI captures.
const assignment = (conditionId, smpPath, values = {}) => ({ conditionId, smpPath, values });
const material = (smpPath, lawId, values) => ({ smpPath, lawId, values });
export const cases = [
  {
    id: 'structural', title: 'Structural cantilever', problemtype: 'structural',
    source: 'cad/examples/STP/block.stp', geometry: 'cantilever.stp',
    ops: [{ op: 'scale', targets: ['solid-0'], center: [0, 0, 0], factors: [6, 1, 1] }],
    parts: [{ name: 'Solid', volumes: ['solid-0'] }, { name: 'Support', surfaces: ['face-3'] }, { name: 'Load', surfaces: ['face-1'] }],
    options: { dimension: 3, sizeMin: 0.8, sizeMax: 0.8 },
    problem: { analysisType: 'non_linear', endTime: 1, timeStep: 0.125 },
    assignments: [assignment('parts', 'Solid'), assignment('displacement', 'Support', { value: [0, 0, 0], constrained: true }), assignment('surfacePressure', 'Load', { value: 100000 })],
    materials: [material('Solid', 'linear_elastic_3d', { DENSITY: 0, YOUNG_MODULUS: 210000000000, POISSON_RATIO: 0.3 })],
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
].map(c => c.planar ? {
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
} : c);
