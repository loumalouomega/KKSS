"""Independent checks of ASCII Kratos VTK output; no optional Python packages."""
import json
import math
import pathlib
import platform
import sys
import re
import importlib.metadata


def vtk(file):
    tokens = file.read_text().split()
    assert 'ASCII' in tokens[:12], 'Expected ASCII VTK'
    i = tokens.index('POINTS')
    count = int(tokens[i + 1])
    points = [list(map(float, tokens[j:j + 3])) for j in range(i + 3, i + 3 + count * 3, 3)]
    i = tokens.index('CELLS')
    cell_count, size = map(int, tokens[i + 1:i + 3])
    cursor = i + 3
    cells = []
    for _ in range(cell_count):
        n = int(tokens[cursor])
        cells.append(list(map(int, tokens[cursor + 1:cursor + 1 + n])))
        cursor += n + 1
    fields = {}
    cursor = tokens.index('POINT_DATA') + 2
    assert tokens[cursor] == 'FIELD'
    nfields = int(tokens[cursor + 2])
    cursor += 3
    for _ in range(nfields):
        name, components, tuples, _type = tokens[cursor:cursor + 4]
        components, tuples = int(components), int(tuples)
        assert tuples == count
        cursor += 4
        fields[name] = [list(map(float, tokens[j:j + components])) for j in range(cursor, cursor + tuples * components, components)]
        cursor += tuples * components
    assert all(math.isfinite(v) for field in fields.values() for row in field for v in row)
    return points, cells, fields


def _face_flux(points, cells, velocity, x_plane, outward_x, tol=1e-9):
    """Outward volume flux through the mesh faces on a plane x = const.

    The ASCII output keeps the reference coordinates, and the inlet and outlet
    planes do not move in x, so the faces there are selected directly.  Linear
    triangles integrate the nodal velocity exactly.  `tol` is the plane
    coincidence: Gmsh keeps CAD faces exact (1e-9), while an MMG-morphed
    tunnel drifts its far-field faces ~1e-5.
    """
    total = 0.0
    for cell in cells:
        on_plane = [i for i in cell if abs(points[i][0] - x_plane) < tol]
        if len(on_plane) != 3:
            continue
        a, b, c = (points[i] for i in on_plane)
        u = [b[k] - a[k] for k in range(3)]
        v = [c[k] - a[k] for k in range(3)]
        n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        if n[0] * outward_x < 0:
            n = [-x for x in n]
        mean_v = [sum(velocity[i][k] for i in on_plane) / 3 for k in range(3)]
        total += 0.5 * sum(n[k] * mean_v[k] for k in range(3))
    return total


def _deformed_volume(points, cells, mesh_displacement):
    """Volume of a tet mesh in its deformed configuration."""
    total = 0.0
    for cell in cells:
        if len(cell) != 4:
            continue
        a, b, c, d = ([points[i][k] + mesh_displacement[i][k] for k in range(3)] for i in cell)
        u = [b[k] - a[k] for k in range(3)]
        v = [c[k] - a[k] for k in range(3)]
        w = [d[k] - a[k] for k in range(3)]
        total += abs(u[0] * (v[1] * w[2] - v[2] * w[1])
                     - u[1] * (v[0] * w[2] - v[2] * w[0])
                     + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6
    return total


def verify_coupled(case, directory):
    """Partitioned channel-over-slab cases: fluid VTK + structure VTK + coupling log."""
    directory = pathlib.Path(directory)
    primary = 'ProjectParametersCoSim.json' if case == 'cosim' else 'ProjectParameters.json'
    parameters = json.loads((directory / primary).read_text())
    recipe = json.loads((directory / 'recipe.json').read_text())
    coupled = recipe['coupled']
    width = coupled['widthMm'] / 1000
    inlet_speed = next(a['values']['modulus'] for a in recipe['assignments'] if a['conditionId'] == 'f_inlet')
    fluid_files = sorted((directory / 'vtk_output').glob('FluidModelPart_*.vtk'), key=lambda p: int(p.stem.rsplit('_', 1)[1]))
    struct_files = sorted((directory / 'vtk_output').glob('Structure_*.vtk'), key=lambda p: int(p.stem.rsplit('_', 1)[1]))
    assert fluid_files, 'No fluid solver results'
    assert struct_files, 'No structure solver results'
    assert len(fluid_files) == len(struct_files), f'Fluid wrote {len(fluid_files)} frames but structure wrote {len(struct_files)}'
    p, cells, fields = vtk(fluid_files[-1])
    ps, struct_cells, struct_fields = vtk(struct_files[-1])
    checks = {}

    def check(name, value, limit):
        assert math.isfinite(value) and value <= limit, f'{name}: {value} > {limit}'
        checks[name] = {'measured': value, 'maximum': limit}

    def check_min(name, value, limit):
        assert math.isfinite(value) and value >= limit, f'{name}: {value} < {limit}'
        checks[name] = {'measured': value, 'minimum': limit}

    velocity, pressure = fields['VELOCITY'], fields['PRESSURE']
    # The two inlet corners on the interface line follow the moving wall
    # (no-slip coupling), not the inlet profile — check the interior instead.
    check('inlet_velocity_error_m_per_s', max(math.dist(v, [inlet_speed, 0, 0]) for xyz, v in zip(p, velocity) if abs(xyz[0]) < 1e-8 and xyz[1] > 1e-8), 1e-6)
    checks['interface_corner_speed_m_per_s'] = max(math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) for xyz, v in zip(p, velocity) if abs(xyz[0]) < 1e-8 and xyz[1] <= 1e-8)
    check('outlet_pressure_error_Pa', max(abs(v[0]) for xyz, v in zip(p, pressure) if abs(xyz[0] - width) < 1e-8), 1e-6)

    def face_mean(x):
        vals = [v[0] for xyz, v in zip(p, velocity) if abs(xyz[0] - x) < 1e-8]
        assert len(vals) >= 2
        return sum(vals) / len(vals), len(vals)
    inlet_mean, inlet_nodes = face_mean(0)
    outlet_mean, outlet_nodes = face_mean(width)
    check('inlet_face_mean_m_per_s', abs(inlet_mean - inlet_speed), 0.02)
    checks['outlet_face_mean_m_per_s'] = outlet_mean
    checks['inlet_face_nodes'] = inlet_nodes
    checks['outlet_face_nodes'] = outlet_nodes

    # An incompressible solve pushes the inflow straight through, and the slab
    # sweeps the ALE domain (mm-scale motion over 0.2 m2), so the outlet
    # carries the inflow plus the squeeze - the quiescent-outlet premise does
    # not hold.  Assert instead the ALE mass balance over the sampled window:
    # the net outward flux through inlet and outlet equals minus the volume
    # change of the moving fluid domain.  The trapezoid rule over three
    # samples of a fast transient is coarse, hence the generous tolerance.
    assert len(fluid_files) >= 2, 'The ALE mass balance needs at least two fluid frames'
    fluid_settings = parameters['solver_settings'].get('fluid_solver_settings')
    if fluid_settings is None:    # cosim: the fluid participant has its own document
        cfd = json.loads((directory / 'ProjectParametersCFD.json').read_text())
        fluid_settings = cfd['solver_settings']['fluid_solver_settings']
    time_step = fluid_settings['time_stepping']['time_step']
    volumes, net_fluxes, inlet_flux = [], [], None
    for path in fluid_files:
        frame_points, frame_cells, frame_fields = vtk(path)
        assert 'MESH_DISPLACEMENT' in frame_fields, 'ALE fluid output carries no MESH_DISPLACEMENT'
        frame_velocity = frame_fields['VELOCITY']
        inlet = _face_flux(frame_points, frame_cells, frame_velocity, 0.0, -1.0)
        outlet = _face_flux(frame_points, frame_cells, frame_velocity, width, +1.0)
        if inlet_flux is None:
            inlet_flux = inlet
        volumes.append(_deformed_volume(frame_points, frame_cells, frame_fields['MESH_DISPLACEMENT']))
        net_fluxes.append(inlet + outlet)
    delivered = time_step * abs(inlet_flux)
    integrated = time_step * (sum(net_fluxes[1:-1]) + (net_fluxes[0] + net_fluxes[-1]) / 2)
    volume_change = volumes[-1] - volumes[0]
    checks['delivered_volume_m3'] = delivered
    checks['fluid_volume_change_m3'] = volume_change
    check('ale_mass_balance_error', abs(integrated + volume_change) / delivered, 0.35)

    displacement = struct_fields['DISPLACEMENT']
    peak = max(math.sqrt(sum(x * x for x in v)) for v in displacement)
    check_min('peak_structure_displacement_m', peak, 1e-7)
    check('peak_structure_displacement_limit_m', peak, 0.02)
    checks['peak_structure_displacement_m'] = peak

    convergence = (directory / 'kkss-convergence-v2.jsonl').read_text().strip().split('\n')
    records = [json.loads(line) for line in convergence if line.strip()]
    steps = [r for r in records if r.get('event') == 'step']
    assert steps, 'Coupling convergence log has no step records'
    assert len(steps) == len(fluid_files), f'Coupling log has {len(steps)} steps but the fluid wrote {len(fluid_files)} frames'
    checks['coupling_steps'] = len(steps)
    checks['coupling_iterations_per_step'] = [r.get('nonlinearIteration', 0) for r in steps]
    assert all(r.get('nonlinearIteration', 0) >= 1 for r in steps), 'A coupled step recorded no coupling iteration'
    assert all(r.get('solverStepResult') is not False for r in steps), 'A coupled step did not solve'
    checks['coupling_nonconverged_steps'] = sum(1 for r in steps if r.get('converged') is False)
    return {'case': case, 'python': platform.python_version(), 'kratos': importlib.metadata.version('KratosMultiphysics'),
            'threads': 2, 'nodes': len(p) + len(ps), 'elements': len(cells) + len(struct_cells),
            'fields': sorted(set(fields) | set(struct_fields)),
            'result': str(fluid_files[-1].relative_to(directory)),
            'structure_result': str(struct_files[-1].relative_to(directory)),
            'frames': len(fluid_files),
            'end_time': parameters['problem_data']['end_time'], 'checks': checks}


def _face_flux_2d(points, cells, velocity, x_plane, outward_x):
    """Outward flux through the boundary edges on a plane x = const (2D).

    Linear triangles integrate the edge mean velocity exactly; the deformed
    and reference inlet/outlet planes coincide because the ALE boundary
    condition holds their mesh.
    """
    total = 0.0
    for cell in cells:
        on_plane = [i for i in cell if abs(points[i][0] - x_plane) < 1e-9]
        if len(on_plane) != 2:
            continue
        a, b = (points[i] for i in on_plane)
        mean_vx = sum(velocity[i][0] for i in on_plane) / 2
        total += outward_x * mean_vx * abs(b[1] - a[1])
    return total


def _deformed_area(points, cells, mesh_displacement):
    """Area of a triangle mesh in its deformed configuration."""
    total = 0.0
    for cell in cells:
        a, b, c = ([points[i][k] + mesh_displacement[i][k] for k in range(3)] for i in cell)
        u = (b[0] - a[0], b[1] - a[1])
        v = (c[0] - a[0], c[1] - a[1])
        total += abs(u[0] * v[1] - u[1] * v[0]) / 2
    return total


def verify_mok(directory):
    """Mok benchmark: 2D fluid VTK + flexible-wall VTK + coupling log.

    Point A is the wall tip (0.500, 0.250). The published comparison
    (data/Mok_ux_A.png, the cyan Kratos solution) puts its horizontal
    displacement at about 8.3 cm around t = 9.5 s and 6.2 cm at t = 25 s; the
    checks compare this case's tip against those values within the tolerance a
    different discretisation earns, and record the measured numbers either
    way. The per-frame fluid output is also checked against the imposed steady
    inlet profile and against the ALE area balance.
    """
    directory = pathlib.Path(directory)
    parameters = json.loads((directory / 'ProjectParameters.json').read_text())
    fluid_files = sorted((directory / 'vtk_output').glob('FluidModelPart_*.vtk'), key=lambda p: int(p.stem.rsplit('_', 1)[1]))
    struct_files = sorted((directory / 'vtk_output').glob('Structure_*.vtk'), key=lambda p: int(p.stem.rsplit('_', 1)[1]))
    assert fluid_files, 'No fluid solver results'
    assert struct_files, 'No structure solver results'
    assert len(fluid_files) == len(struct_files), f'Fluid wrote {len(fluid_files)} frames but structure wrote {len(struct_files)}'
    checks = {}

    def check(name, value, limit):
        assert math.isfinite(value) and value <= limit, f'{name}: {value} > {limit}'
        checks[name] = {'measured': value, 'maximum': limit}

    def check_min(name, value, limit):
        assert math.isfinite(value) and value >= limit, f'{name}: {value} < {limit}'
        checks[name] = {'measured': value, 'minimum': limit}

    dt = parameters['solver_settings']['fluid_solver_settings']['time_stepping']['time_step']
    state = json.loads((directory / 'mesh.kratoscase.json').read_text())
    frame_dt = dt * int(state.get('output', {}).get('interval', 1))

    # Final fluid frame: the steady-phase inlet parabola at x = 0 (the ramp
    # expression hands over at t = 10 s and the case ends at 25 s) and the
    # zero-pressure outlet.
    p, cells, fields = vtk(fluid_files[-1])
    velocity, pressure = fields['VELOCITY'], fields['PRESSURE']
    check('inlet_profile_error_m_per_s',
          max(abs(v[0] - 0.2428 * xyz[1] * (1 - xyz[1])) for xyz, v in zip(p, velocity) if abs(xyz[0]) < 1e-9), 1e-6)
    check('outlet_pressure_error_Pa', max(abs(v[0]) for xyz, v in zip(p, pressure) if abs(xyz[0] - 1.75) < 1e-9), 1e-6)

    # ALE mass balance over the whole run: the net outward flux through inlet
    # and outlet equals minus the change of the moving fluid area (2D, unit
    # thickness). The trapezoid over the saved frames is dense (every 0.5 s).
    assert 'MESH_DISPLACEMENT' in fields, 'ALE fluid output carries no MESH_DISPLACEMENT'
    net_fluxes, inflowing, areas = [], [], []
    for path in fluid_files:
        frame_points, frame_cells, frame_fields = vtk(path)
        frame_velocity = frame_fields['VELOCITY']
        inlet = _face_flux_2d(frame_points, frame_cells, frame_velocity, 0.0, -1.0)
        outlet = _face_flux_2d(frame_points, frame_cells, frame_velocity, 1.75, +1.0)
        net_fluxes.append(inlet + outlet)
        inflowing.append(abs(inlet))
        areas.append(_deformed_area(frame_points, frame_cells, frame_fields['MESH_DISPLACEMENT']))
    def trapezoid(values):
        return frame_dt * (sum(values[1:-1]) + (values[0] + values[-1]) / 2)
    delivered = trapezoid(inflowing)
    check('ale_area_balance_error', abs(trapezoid(net_fluxes) + (areas[-1] - areas[0])) / delivered, 0.02)
    checks['delivered_area_m2'] = delivered
    checks['fluid_area_change_m2'] = areas[-1] - areas[0]

    # Point A, the wall tip at (0.500, 0.250): the leftmost node on the top
    # edge, in every frame.
    tip = []
    for path in struct_files:
        ps, _, sf = vtk(path)
        top = [i for i, q in enumerate(ps) if q[1] > 0.25 - 1e-6]
        assert top, 'No wall tip nodes in the structure output'
        tip.append(sf['DISPLACEMENT'][min(top, key=lambda k: ps[k][0])][0])
    peak = max(tip)
    checks['tip_ux_peak_m'] = peak
    checks['tip_ux_peak_time_s'] = tip.index(peak) * frame_dt
    checks['tip_ux_final_m'] = tip[-1]
    check_min('tip_ux_peak_m_minimum', peak, 0.03)
    check('tip_ux_peak_vs_published_error_m', abs(peak - 0.083), 0.020)
    check('tip_ux_final_vs_published_error_m', abs(tip[-1] - 0.062), 0.015)

    convergence = (directory / 'kkss-convergence-v2.jsonl').read_text().strip().split('\n')
    records = [json.loads(line) for line in convergence if line.strip()]
    steps = [r for r in records if r.get('event') == 'step']
    assert steps, 'Coupling convergence log has no step records'
    iterations = [r.get('nonlinearIteration', 0) for r in steps]
    assert all(r.get('solverStepResult') is not False for r in steps), 'A coupled step did not solve'
    checks['coupling_steps'] = len(steps)
    checks['coupling_iterations_max'] = max(iterations)
    checks['coupling_iterations_mean'] = sum(iterations) / len(iterations)
    checks['coupling_nonconverged_steps'] = sum(1 for r in steps if r.get('converged') is False)

    ps, struct_cells, struct_fields = vtk(struct_files[-1])
    return {'case': 'fsi', 'python': platform.python_version(), 'kratos': importlib.metadata.version('KratosMultiphysics'),
            'threads': 2, 'nodes': len(p) + len(ps), 'elements': len(cells) + len(struct_cells),
            'fields': sorted(set(fields) | set(struct_fields)),
            'result': str(fluid_files[-1].relative_to(directory)),
            'structure_result': str(struct_files[-1].relative_to(directory)),
            'frames': len(fluid_files),
            'end_time': parameters['problem_data']['end_time'], 'checks': checks}



def verify_rans(directory):
    """Turbulent obstacle channel: the laminar checks plus the RANS evidence.

    The obstacle carries the logarithmic wall function instead of no-slip, so
    its nodes are checked for a log-layer y+ rather than zero speed. The
    flowForces monitor integrates pressure and viscous traction over the
    obstacle; the streamwise momentum balance predicts that drag from the
    inlet/outlet pressure and momentum fluxes, closing the loop.
    """
    directory = pathlib.Path(directory)
    recipe = json.loads((directory / 'recipe.json').read_text())
    obstacle = recipe['obstacle']
    width = obstacle['widthMm'] / 1000
    cx, cy = (v / 1000 for v in obstacle['centerMm'])
    radius = obstacle['radiusMm'] / 1000
    inlet_speed = next(a['values']['modulus'] for a in recipe['assignments'] if a['conditionId'] == 'inlet')
    density = next(m['values']['DENSITY'] for m in recipe['materials'] if m['smpPath'] == 'Domain')
    viscosity = next(m['values']['DYNAMIC_VISCOSITY'] for m in recipe['materials'] if m['smpPath'] == 'Domain')
    mdpa = (directory / 'mesh_case.mdpa').read_text()
    for name in ('Domain', 'Inlet', 'Outlet', 'Walls', 'Obstacle'):
        assert f'Begin SubModelPart {name}\n' in mdpa, f'Missing named region {name} in generated MDPA'
    parameters = json.loads((directory / 'ProjectParameters.json').read_text())
    files = sorted((directory / 'vtk_output').glob('*.vtk'), key=lambda p: int(p.stem.rsplit('_', 1)[1]))
    assert files, 'No solver results'
    p, cells, fields = vtk(files[-1])
    for name in ('VELOCITY', 'PRESSURE', 'TURBULENT_KINETIC_ENERGY', 'TURBULENT_VISCOSITY', 'RANS_Y_PLUS'):
        assert name in fields, f'Missing RANS field {name} in solver output'
    checks = {}

    def check(name, value, limit):
        assert math.isfinite(value) and value <= limit, f'{name}: {value} > {limit}'
        checks[name] = {'measured': value, 'maximum': limit}

    def check_min(name, value, limit):
        assert math.isfinite(value) and value >= limit, f'{name}: {value} < {limit}'
        checks[name] = {'measured': value, 'minimum': limit}

    velocity, pressure = fields['VELOCITY'], fields['PRESSURE']
    check('inlet_velocity_error_m_per_s', max(math.dist(v, [inlet_speed, 0, 0]) for xyz, v in zip(p, velocity) if abs(xyz[0]) < 1e-8), 1e-6)
    check('outlet_pressure_error_Pa', max(abs(v[0]) for xyz, v in zip(p, pressure) if abs(xyz[0] - width) < 1e-8), 1e-6)

    def face_profile(x):
        boundary = sorted(((xyz[1], v[0], v2[0]) for xyz, v, v2 in zip(p, velocity, pressure) if abs(xyz[0] - x) < 1e-8))
        assert len(boundary) >= 2
        pairs = list(zip(boundary, boundary[1:]))
        weights = [(b[0] - a[0]) for a, b in pairs]
        total = sum(weights)
        flux = sum(w * (a[1] + b[1]) / 2 for w, (a, b) in zip(weights, pairs))
        momentum = sum(w * (a[1]**2 + b[1]**2) / 2 for w, (a, b) in zip(weights, pairs))
        press = sum(w * (a[2] + b[2]) / 2 for w, (a, b) in zip(weights, pairs))
        return flux, momentum, press / total, total
    in_flux, in_mom, in_p, height = face_profile(0)
    out_flux, out_mom, out_p, _ = face_profile(width)
    check('flux_imbalance_m2_per_s', abs(in_flux - out_flux), 0.001)
    checks['inlet_flux_m2_per_s'] = in_flux
    checks['outlet_flux_m2_per_s'] = out_flux

    # The wall-function wall: y+ of the obstacle-adjacent nodes, log layer.
    # Neither Y_PLUS (ComputeYPlusProcess) nor RANS_Y_PLUS (the wall
    # formulation) reaches the nodal VTK — both live on the conditions, which
    # GiD shows but VTK does not — so the check reconstructs y+ from the
    # solution itself: u_tau from the wall-normal velocity gradient and the
    # first interior row height. Stagnation and base-bleed stations are
    # excluded by sector: tau_w vanishes there at any mesh.
    nu = viscosity / density
    wall_ids = [i for i, xyz in enumerate(p) if abs(math.hypot(xyz[0] - cx, xyz[1] - cy) - radius) <= 1e-6]
    assert len(wall_ids) >= 12, f'Obstacle boundary has only {len(wall_ids)} sampled result nodes'
    checks['obstacle_boundary_nodes'] = len(wall_ids)
    yplus = []
    for i in wall_ids:
        ang = math.degrees(math.atan2(p[i][1] - cy, p[i][0] - cx))
        if not 45 < abs(ang) < 135:
            continue
        x, y = p[i][0], p[i][1]
        j = min((k for k in range(len(p)) if math.hypot(p[k][0] - cx, p[k][1] - cy) - radius > 0.001),
                key=lambda k: math.hypot(p[k][0] - x, p[k][1] - y))
        h = math.hypot(p[j][0] - x, p[j][1] - y)
        dut = (math.hypot(*velocity[j][:2]) - math.hypot(*velocity[i][:2])) / h
        if dut <= 0:
            continue
        u_tau = math.sqrt(nu * dut)
        yplus.append(h * u_tau / nu)
    assert len(yplus) >= 6, f'Only {len(yplus)} shoulder stations for the y+ check'
    mean_yplus = sum(yplus) / len(yplus)
    checks['wall_y_plus_stations'] = len(yplus)
    checks['wall_y_plus_min'] = min(yplus)
    checks['wall_y_plus_max'] = max(yplus)
    check_min('mean_wall_y_plus', mean_yplus, 30)
    check('mean_wall_y_plus_limit', mean_yplus, 300)
    checks['wall_y_plus_log_layer_share'] = sum(1 for v in yplus if 30 <= v <= 300) / len(yplus)

    # Turbulence stays alive; the AFC stabilization admits a small bounded
    # undershoot of k below zero at sharp gradients, so positivity is a
    # ratio against the peak, not an absolute floor (about 5% on this
    # coarse tutorial mesh).
    k = [v[0] for v in fields['TURBULENT_KINETIC_ENERGY']]
    nut = [v[0] for v in fields['TURBULENT_VISCOSITY']]
    check_min('turbulent_kinetic_energy_maximum', max(k), 1e-6)
    check('turbulent_kinetic_energy_undershoot_ratio', -min(k) / max(k), 0.10)
    check_min('turbulent_viscosity_maximum', max(nut), 0)
    check('turbulent_viscosity_minimum', -min(nut), 1e-12)

    # Drag from the monitor against the momentum balance. The transient sheds
    # for the first seconds, so the check reads the mean over the last ten
    # steps (about 1.7 shedding periods), not the phase-dependent final step.
    drag_files = sorted(directory.glob('*_drag.dat'))
    assert drag_files, 'No drag monitor output'
    rows = [line.split() for line in drag_files[0].read_text().splitlines() if line.strip() and not line.startswith('#')]
    assert len(rows) >= 10, 'Drag monitor output holds no settled steps'
    drag_x = sum(float(r[1]) for r in rows[-10:]) / 10
    check_min('drag_x_N_per_m', drag_x, 0)
    checks['drag_steps'] = len(rows)
    checks['drag_final_N_per_m'] = float(rows[-1][1])
    diameter = 2 * radius
    cd = drag_x / (0.5 * density * inlet_speed**2 * diameter)
    checks['drag_coefficient'] = cd
    # 2D k-epsilon at 20% blockage drags harder than the unconfined-cylinder
    # ~1.2 the textbooks quote; the check pins the tutorial's own regime.
    check_min('drag_coefficient_minimum', cd, 1.5)
    check('drag_coefficient_maximum', cd, 4.5)
    predicted = (in_p - out_p) * height - density * (out_mom - in_mom)
    checks['momentum_predicted_drag_N_per_m'] = predicted
    check('drag_vs_momentum_relative_error', abs(drag_x - predicted) / drag_x, 0.15)

    wake = [v[0] for xyz, v in zip(p, velocity)
            if cx + 1.5 * radius <= xyz[0] <= cx + 5 * radius and abs(xyz[1] - cy) <= 0.35 * radius]
    assert wake, 'The refined near-wake sample contains no result nodes'
    check_min('near_wake_velocity_deficit_m_per_s', inlet_speed - min(wake), 0.025)
    check_min('pressure_range_Pa', max(v[0] for v in pressure) - min(v[0] for v in pressure), 0.05)
    checks['reynolds_number'] = density * inlet_speed * diameter / viscosity
    checks['wake_sample_nodes'] = len(wake)
    checks['minimum_near_wake_axial_velocity_m_per_s'] = min(wake)
    return {'case': 'rans', 'python': platform.python_version(), 'kratos': importlib.metadata.version('KratosMultiphysics'),
            'threads': 2, 'nodes': len(p), 'elements': len(cells), 'fields': list(fields),
            'result': str(files[-1].relative_to(directory)), 'frames': len(files),
            'end_time': parameters['problem_data']['end_time'], 'checks': checks}


def verify_eigen(directory):
    """Cantilever free vibration: the solver's eigenvalues vs Euler-Bernoulli.

    The eigenvalue run writes no VTK (the GiD postprocess replaces the output),
    so the check reads the EIGENVALUE_VECTOR the driver prints to solver.log
    and compares the first bending frequencies in each transverse plane against
    the analytic cantilever values. The 18 x 4 x 5 mm solid has a 6:1 length
    aspect, hence the 10% documented tolerance.
    """
    directory = pathlib.Path(directory)
    log = (directory / 'solver.log').read_text()
    found = re.findall(r'Eigenvalues = \[(.*?)\]', log)
    assert found, 'solver.log carries no EIGENVALUE_VECTOR'
    eigenvalues = sorted(float(x) for x in found[-1].replace(',', ' ').split())
    recipe = json.loads((directory / 'recipe.json').read_text())
    expected = recipe['problem'].get('eigenCount', 3)
    assert len(eigenvalues) == expected, f'Expected {expected} eigenvalues, found {len(eigenvalues)}'
    freqs = [math.sqrt(lam) / (2 * math.pi) for lam in eigenvalues]
    length, sec_y, sec_z = 0.018, 0.004, 0.005
    young, density = 210e9, 7850
    area = sec_y * sec_z
    beam_factor = 1.875**2 / (2 * math.pi * length**2)
    ref_lateral = beam_factor * math.sqrt(young * (sec_z * sec_y**3 / 12) / (density * area))
    ref_vertical = beam_factor * math.sqrt(young * (sec_y * sec_z**3 / 12) / (density * area))
    checks = {}
    for i, f in enumerate(freqs):
        checks[f'eigenfrequency_{i + 1}_Hz'] = f

    def check_rel(name, value, ref, tol):
        err = abs(value - ref) / ref
        assert math.isfinite(err) and err <= tol, f'{name}: {value} vs {ref}'
        checks[name] = {'measured': value, 'reference': ref, 'maximum': tol}

    check_rel('first_lateral_frequency_relative_error', freqs[0], ref_lateral, 0.10)
    checks['first_lateral_reference_Hz'] = ref_lateral
    check_rel('second_vertical_frequency_relative_error', freqs[1], ref_vertical, 0.10)
    checks['second_vertical_reference_Hz'] = ref_vertical
    nodes = elements = 0
    section = None
    for line in (directory / 'mesh_case.mdpa').read_text().splitlines():
        s = line.strip()
        if s == 'Begin Nodes':
            section = 'nodes'
        elif s.startswith('Begin Elements'):
            section = 'elements'
        elif s.startswith('End '):
            section = None
        elif section == 'nodes' and s and s[0].isdigit():
            nodes += 1
        elif section == 'elements' and s and s[0].isdigit():
            elements += 1
    checks['eigenvalue_count'] = len(eigenvalues)
    return {'case': 'eigen', 'python': platform.python_version(), 'kratos': importlib.metadata.version('KratosMultiphysics'),
            'threads': 2, 'nodes': nodes, 'elements': elements, 'fields': [],
            'result': 'solver.log', 'frames': 0, 'checks': checks}


def verify_two_fluids(directory):
    """Dam-break tank, generation only: the solver is blocked upstream.

    Checks the generated mesh carries the level-set interface (a nodal
    DISTANCE field, zero on the water region, positive into the air) and the
    two fluid materials in solver order on the same part. No solver output is
    read; generate.mjs records the reproducible upstream ModuleNotFoundError.
    """
    directory = pathlib.Path(directory)
    recipe = json.loads((directory / 'recipe.json').read_text())
    text = (directory / 'mesh_case.mdpa').read_text()
    parts = set(re.findall(r'Begin SubModelPart (\S+)', text))
    for name in ('Domain', 'Water', 'Walls'):
        assert name in parts, f'Missing named region {name} in generated MDPA'
    fields, part_nodes, current, in_nodes = {}, {}, None, False
    field, field_nodal, field_rows = None, False, {}
    for line in text.splitlines():
        s = line.strip()
        m = re.match(r'Begin SubModelPart (\S+)', s)
        if m:
            current = m.group(1)
        elif s == 'End SubModelPart':
            current, in_nodes = None, False
        elif s == 'Begin SubModelPartNodes':
            in_nodes = True
            part_nodes.setdefault(current, [])
        elif s == 'End SubModelPartNodes':
            in_nodes = False
        elif in_nodes and s and s[0].isdigit():
            part_nodes[current].append(int(s.split()[0]))
        else:
            # Nodal rows carry an is_fixed flag: `id is_fixed value`
            # (scalar) or `id [fixed] (v1, v2, ...)` (vector). The value is
            # what the interface check reads.
            m2 = re.match(r'Begin NodalData (\S+)', s)
            if m2:
                field, field_rows, field_nodal = m2.group(1), {}, True
                fields[field] = field_rows
            elif s.startswith('End NodalData'):
                field = None
            elif 'field' in dir() and field and s and (s[0].isdigit() or s[0] == '-'):
                row = s.split()
                if '(' in s:
                    vals = [float(x) for x in s[s.index('(') + 1:s.index(')')].split(',') if x.strip()]
                elif len(row) >= 3 and field_nodal:
                    vals = [float(row[2])]
                else:
                    vals = [float(x) for x in row[1:]]
                field_rows[int(row[0])] = vals
    assert 'DISTANCE' in fields, 'Generated mesh carries no nodal DISTANCE field'
    distance = fields['DISTANCE']
    water_ids = part_nodes.get('Water', [])
    assert water_ids, 'Water part holds no nodes'
    water_vals = [distance[i][0] for i in water_ids if i in distance]
    assert len(water_vals) == len(water_ids), 'DISTANCE misses Water nodes'
    checks = {'water_nodes': len(water_ids)}
    worst = max(abs(v) for v in water_vals)
    checks['water_distance_max_abs'] = worst
    assert worst <= 1e-6, f'Water region not on the interface: max |DISTANCE| {worst}'
    far = max(v[0] for v in distance.values())
    checks['air_distance_maximum'] = far
    assert far >= 1.0, f'No air node far from the interface: max DISTANCE {far}'
    laws = [m['lawId'] for m in recipe['materials']]
    assert len(laws) >= 2 and laws[0].startswith('phase_1_') and laws[1].startswith('phase_2_'), f'Materials not water-then-air: {laws}'
    assert recipe['materials'][0]['smpPath'] == recipe['materials'][1]['smpPath'] == 'Domain'
    checks['material_order'] = laws[:2]
    return {'case': 'two-fluids', 'python': platform.python_version(), 'kratos': importlib.metadata.version('KratosMultiphysics'),
            'threads': 2, 'nodes': len(distance), 'elements': 0, 'fields': ['DISTANCE'],
            'result': 'mesh_case.mdpa', 'frames': 0, 'checks': checks}


def verify_wind_tunnel(directory):
    """Wizard sphere tunnel: the report's plan against the solver's answer.

    A steady RANS k-omega SST run on the generated tunnel. The wall y+ the
    solver writes on the body is compared with the first-layer y+ the plan
    promised; the drag coefficient is recorded as informational (no
    published benchmark at this Reynolds number). Inlet/outlet flux closes
    the mass balance.
    """
    directory = pathlib.Path(directory)
    recipe = json.loads((directory / 'recipe.json').read_text())
    plan, report = recipe['plan'], recipe['report']
    parameters = json.loads((directory / 'ProjectParameters.json').read_text())
    files = sorted((directory / 'vtk_output').glob('*.vtk'), key=lambda p: int(p.stem.rsplit('_', 1)[1]))
    assert files, 'No solver results'
    p, cells, fields = vtk(files[-1])
    checks = {}

    def check(name, value, limit):
        assert math.isfinite(value) and value <= limit, f'{name}: {value} > {limit}'
        checks[name] = {'measured': value, 'maximum': limit}

    def check_min(name, value, limit):
        assert math.isfinite(value) and value >= limit, f'{name}: {value} < {limit}'
        checks[name] = {'measured': value, 'minimum': limit}

    # Neither Y_PLUS (ComputeYPlusProcess) nor RANS_Y_PLUS (the wall
    # formulation) reaches the nodal VTK — both live on the conditions —
    # so the measured y+ is reconstructed from the solution itself, as for
    # the RANS obstacle case: u_tau from the wall-normal velocity gradient
    # at shoulder stations (stagnation and base bleed excluded by sector),
    # y+ from the first-row height. The body STL is meshed fine enough that
    # the snapped wall sits within a millimetre of the analytic sphere.
    radius = plan['body']['size'][0] / 2
    viscosity = plan['flow']['viscosity']
    density = plan['flow']['density']
    nu = viscosity / density
    velocity = fields['VELOCITY']
    wall = [i for i, xyz in enumerate(p) if abs(math.dist(xyz, [0, 0, 0]) - radius) <= 0.002]
    assert len(wall) >= 100, f'Only {len(wall)} wall-adjacent result nodes'
    interior = [i for i, xyz in enumerate(p) if math.dist(xyz, [0, 0, 0]) - radius > 0.003]
    yplus = []
    for i in wall:
        ang = math.degrees(math.acos(max(-1.0, min(1.0, p[i][0] / radius))))
        if not 45 < ang < 135:
            continue
        x, y, z = p[i]
        j = min(interior, key=lambda k: math.dist(p[k], [x, y, z]))
        h = math.dist(p[j], [x, y, z])
        dut = (math.sqrt(sum(v * v for v in velocity[j])) - math.sqrt(sum(v * v for v in velocity[i]))) / h
        if dut <= 0:
            continue
        yplus.append(h * math.sqrt(nu * dut) / nu)
    assert len(yplus) >= 100, f'Only {len(yplus)} shoulder stations for the y+ check'
    mean_yplus = sum(yplus) / len(yplus)
    planned = report['firstLayer']['yPlus']
    checks['wall_y_plus_nodes'] = len(wall)
    checks['wall_y_plus_mean'] = mean_yplus
    checks['wall_y_plus_planned'] = planned
    checks['wall_y_plus_measured_over_planned'] = mean_yplus / planned
    # Both independent reconstructions (this secant and nut/(kappa·h))
    # agree, and the number is steady across steps — but it reads about half
    # the flat-plate plan basis: a sphere boundary layer under pressure
    # gradient and separation is not a flat plate, and the secant under-reads
    # a logarithmic profile. The check is order-of-magnitude agreement that
    # catches a wrong layer (y+ ~ 5 or ~ 2000), not a calibration.
    check('wall_y_plus_ratio_limit', mean_yplus / planned, 2.5)
    check_min('wall_y_plus_ratio_minimum', mean_yplus / planned, 0.4)
    checks['wall_y_plus_log_layer_share'] = sum(1 for v in yplus if 30 <= v <= 300) / len(yplus)

    # The wizard's MMG passes drift the far-field faces ~1e-5 off the plan
    # extents, so the planes are read off the solution mesh itself.
    xmin = min(xyz[0] for xyz in p)
    xmax = max(xyz[0] for xyz in p)
    velocity = fields['VELOCITY']
    inlet = _face_flux(p, cells, velocity, xmin, -1.0, tol=1e-6)
    outlet = _face_flux(p, cells, velocity, xmax, +1.0, tol=1e-6)
    checks['inlet_flux_m3_per_s'] = inlet
    checks['outlet_flux_m3_per_s'] = outlet
    check('flux_imbalance_relative', abs(inlet + outlet) / abs(inlet), 0.05)

    # The steady run may still breathe with vortex shedding at the final
    # step, so the check reads the mean over the last ten steps (as for the
    # RANS obstacle), not the phase-dependent final one.
    drag_files = sorted(directory.glob('*_drag.dat'))
    assert drag_files, 'No drag monitor output'
    rows = [line.split() for line in drag_files[0].read_text().splitlines() if line.strip() and not line.startswith('#')]
    assert len(rows) >= 10, 'Drag monitor output holds no settled steps'
    drag_x = sum(float(r[1]) for r in rows[-10:]) / 10
    check_min('drag_x_N', drag_x, 0)
    rho = plan['flow']['density']
    speed = plan['flow']['speed']
    # A half model integrates the force over half the body.
    area = plan['body']['frontalArea'] * (0.5 if plan.get('domain', {}).get('halfModel') else 1.0)
    cd = drag_x / (0.5 * rho * speed**2 * area)
    checks['drag_coefficient_informational'] = cd
    checks['drag_steps'] = len(rows)
    checks['drag_final_N'] = float(rows[-1][1])
    return {'case': 'wind-tunnel', 'python': platform.python_version(), 'kratos': importlib.metadata.version('KratosMultiphysics'),
            'threads': 2, 'nodes': len(p), 'elements': len(cells), 'fields': list(fields),
            'result': str(files[-1].relative_to(directory)), 'frames': len(files),
            'end_time': parameters['problem_data']['end_time'], 'checks': checks}
def verify(case, directory):
    # recipe.json is the generator's recipe (generate.mjs writes it): only fsi
    # uses `mok` for dispatch, and the published/generated coupled dirs always
    # carry it. Tool-only flows (the scripted AI tutorial stages a case in the
    # app directly) have none — treat that as "no fsi/mok recipe".
    recipe_path = pathlib.Path(directory) / 'recipe.json'
    recipe = json.loads(recipe_path.read_text()) if recipe_path.exists() else {}
    if case == 'fsi' and recipe.get('mok'):
        return verify_mok(directory)
    if case in ('fsi', 'cosim'):
        return verify_coupled(case, directory)
    # These cases do not produce a VTK timeline (eigen writes modes,
    # two-fluids is generation-only), so they dispatch before the generic
    # ProjectParameters/VTK read below.
    if case == 'rans':
        return verify_rans(directory)
    if case == 'eigen':
        return verify_eigen(directory)
    if case == 'two-fluids':
        return verify_two_fluids(directory)
    if case == 'wind-tunnel':
        return verify_wind_tunnel(directory)
    directory = pathlib.Path(directory)
    parameters = json.loads((directory / 'ProjectParameters.json').read_text())
    files = sorted((directory / 'vtk_output').glob('*.vtk'), key=lambda p: int(p.stem.rsplit('_', 1)[1]))
    assert files, 'No solver results'
    p, cells, fields = vtk(files[-1])
    checks = {}

    def check(name, value, limit):
        assert math.isfinite(value) and value <= limit, f'{name}: {value} > {limit}'
        checks[name] = {'measured': value, 'maximum': limit}

    def check_min(name, value, limit):
        assert math.isfinite(value) and value >= limit, f'{name}: {value} < {limit}'
        checks[name] = {'measured': value, 'minimum': limit}

    if case == 'structural':
        uz = max(abs(v[2]) for v in fields['DISPLACEMENT']) * 1000
        reference = (0.1 * 4 * 18**4) / (8 * 210000 * (4 * 5**3 / 12))
        check('beam_displacement_relative_error', abs(uz - reference) / reference, 0.25)
        assert 'VON_MISES_STRESS' in fields
        checks['max_abs_z_displacement_mm'] = uz
        checks['beam_reference_mm'] = reference
        checks['max_von_mises_Pa'] = max(v[0] for v in fields['VON_MISES_STRESS'])
    elif case == 'thermal':
        xmin, xmax = min(v[0] for v in p), max(v[0] for v in p)
        check('linear_temperature_error_K', max(abs(t[0] - (300 + 100 * (v[0] - xmin) / (xmax - xmin))) for v, t in zip(p, fields['TEMPERATURE'])), 0.001)
    elif case == 'fluid':
        recipe = json.loads((directory / 'recipe.json').read_text())
        obstacle = recipe['obstacle']
        width = obstacle['widthMm'] / 1000
        height = obstacle['heightMm'] / 1000
        cx, cy = (v / 1000 for v in obstacle['centerMm'])
        radius = obstacle['radiusMm'] / 1000
        inlet_speed = next(a['values']['modulus'] for a in recipe['assignments'] if a['conditionId'] == 'inlet')
        density = next(m['values']['DENSITY'] for m in recipe['materials'])
        viscosity = next(m['values']['DYNAMIC_VISCOSITY'] for m in recipe['materials'])
        reynolds = density * inlet_speed * (2 * radius) / viscosity
        mdpa = (directory / 'mesh_case.mdpa').read_text()
        for name in ('Domain', 'Inlet', 'Outlet', 'Walls', 'Obstacle'):
            assert f'Begin SubModelPart {name}\n' in mdpa, f'Missing named region {name} in generated MDPA'
        velocity, pressure = fields['VELOCITY'], fields['PRESSURE']
        check('inlet_velocity_error_m_per_s', max(math.dist(v, [inlet_speed, 0, 0]) for xyz, v in zip(p, velocity) if abs(xyz[0]) < 1e-8), 1e-6)
        check('outlet_pressure_error_Pa', max(abs(v[0]) for xyz, v in zip(p, pressure) if abs(xyz[0] - width) < 1e-8), 1e-6)
        def flux(x):
            boundary = sorted((xyz[1], v[0]) for xyz, v in zip(p, velocity) if abs(xyz[0] - x) < 1e-8)
            assert len(boundary) >= 2
            return sum((b[0] - a[0]) * (a[1] + b[1]) / 2 for a, b in zip(boundary, boundary[1:]))
        check('flux_imbalance_m2_per_s', abs(flux(0) - flux(width)), 0.001)
        checks['inlet_flux_m2_per_s'] = flux(0)
        checks['outlet_flux_m2_per_s'] = flux(width)
        obstacle_nodes = [v for xyz, v in zip(p, velocity) if abs(math.hypot(xyz[0] - cx, xyz[1] - cy) - radius) <= 0.0015]
        assert len(obstacle_nodes) >= 24, f'Obstacle boundary has only {len(obstacle_nodes)} sampled result nodes'
        check('obstacle_no_slip_speed_m_per_s', max(math.sqrt(v[0]**2 + v[1]**2) for v in obstacle_nodes), 2e-5)
        wake = [v[0] for xyz, v in zip(p, velocity)
                if cx + 1.5 * radius <= xyz[0] <= cx + 5 * radius and abs(xyz[1] - cy) <= 0.35 * radius]
        assert wake, 'The refined near-wake sample contains no result nodes'
        check_min('near_wake_velocity_deficit_m_per_s', inlet_speed - min(wake), 0.025)
        check_min('pressure_range_Pa', max(v[0] for v in pressure) - min(v[0] for v in pressure), 0.05)
        checks['reynolds_number'] = reynolds
        checks['obstacle_boundary_nodes'] = len(obstacle_nodes)
        checks['wake_sample_nodes'] = len(wake)
        checks['minimum_near_wake_axial_velocity_m_per_s'] = min(wake)
        checks['pressure_minimum_Pa'] = min(v[0] for v in pressure)
        checks['pressure_maximum_Pa'] = max(v[0] for v in pressure)
    elif case == 'potential-flow':
        potential = fields['VELOCITY_POTENTIAL']
        errors = []


        for cell in cells:
            assert len(cell) == 3
            a, b, c = [p[i] for i in cell]
            fa, fb, fc = [potential[i][0] for i in cell]
            dx1, dy1, dx2, dy2 = b[0]-a[0], b[1]-a[1], c[0]-a[0], c[1]-a[1]
            det = dx1*dy2-dx2*dy1
            gradient = [((fb-fa)*dy2-(fc-fa)*dy1)/det, (dx1*(fc-fa)-dx2*(fb-fa))/det]
            errors.append(math.dist(gradient, [10.2, 0]))
        check('potential_gradient_error_m_per_s', max(errors), 0.001)
    elif case == 'shallow-water':
        check('depth_error_m', max(abs(v[0]-1) for v in fields['HEIGHT']), 1e-6)
        check('momentum_m2_per_s', max(math.sqrt(sum(x*x for x in v)) for v in fields['MOMENTUM']), 1e-6)
        volume = 0
        for cell in cells:
            assert len(cell) == 3
            a, b, c = [p[i] for i in cell]
            area = abs((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/2
            volume += area * sum(fields['HEIGHT'][i][0] for i in cell)/3
        check('water_volume_error_m3', abs(volume-4), 1e-6)
        checks['water_volume_m3'] = volume
    else:
        raise ValueError(case)
    return {'case': case, 'python': platform.python_version(), 'kratos': importlib.metadata.version('KratosMultiphysics'),
            'threads': 2, 'nodes': len(p), 'elements': len(cells), 'fields': list(fields),
            'result': str(files[-1].relative_to(directory)), 'frames': len(files),
            'end_time': parameters['problem_data']['end_time'], 'checks': checks}


if __name__ == '__main__':
    print(json.dumps(verify(sys.argv[1], sys.argv[2]), indent=2))
