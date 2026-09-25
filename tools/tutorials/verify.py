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


def verify(case, directory):
    directory = pathlib.Path(directory)
    parameters = json.loads((directory / 'ProjectParameters.json').read_text())
    files = sorted((directory / 'vtk_output').glob('*.vtk'), key=lambda p: int(p.stem.rsplit('_', 1)[1]))
    assert files, 'No solver results'
    p, cells, fields = vtk(files[-1])
    checks = {}

    def check(name, value, limit):
        assert math.isfinite(value) and value <= limit, f'{name}: {value} > {limit}'
        checks[name] = {'measured': value, 'maximum': limit}

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
        velocity, pressure = fields['VELOCITY'], fields['PRESSURE']
        check('uniform_velocity_error_m_per_s', max(math.dist(v, [1, 0, 0]) for v in velocity), 0.01)
        check('inlet_velocity_error_m_per_s', max(math.dist(v, [1, 0, 0]) for xyz, v in zip(p, velocity) if abs(xyz[0]) < 1e-8), 1e-7)
        check('outlet_pressure_error_Pa', max(abs(v[0]) for xyz, v in zip(p, pressure) if abs(xyz[0] - 4) < 1e-8), 1e-7)
        def flux(x):
            boundary = sorted((xyz[1], v[0]) for xyz, v in zip(p, velocity) if abs(xyz[0] - x) < 1e-8)
            assert len(boundary) >= 2
            return sum((b[0] - a[0]) * (a[1] + b[1]) / 2 for a, b in zip(boundary, boundary[1:]))
        check('flux_imbalance_m2_per_s', abs(flux(0) - flux(4)), 0.01)
        checks['inlet_flux_m2_per_s'] = flux(0)
        checks['outlet_flux_m2_per_s'] = flux(4)
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
