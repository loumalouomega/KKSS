"""Independent checks of ASCII Kratos VTK output; no optional Python packages."""
import json
import math
import pathlib
import platform
import sys
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


def _face_flux(points, cells, velocity, x_plane, outward_x):
    """Outward volume flux through the mesh faces on a plane x = const.

    The ASCII output keeps the reference coordinates, and the inlet and outlet
    planes do not move in x, so the faces there are selected directly.  Linear
    triangles integrate the nodal velocity exactly.
    """
    total = 0.0
    for cell in cells:
        on_plane = [i for i in cell if abs(points[i][0] - x_plane) < 1e-9]
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


def verify(case, directory):
    if case in ('fsi', 'cosim'):
        return verify_coupled(case, directory)
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
