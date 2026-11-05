"""Solver-free self-test of verify.py: synthetic ASCII VTK results that satisfy each single-physics check, then the negative
controls that must break exactly one check each. Run by test/verifyControls.test.ts; needs no Kratos."""
import importlib.metadata
import json
import math
import pathlib
import sys
import tempfile

importlib.metadata.version = lambda name: 'selftest'   # verify() records the Kratos version; there is none here
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import verify  # noqa: E402


def write_vtk(path, points, cells, fields):
    lines = ['# vtk DataFile Version 3.0', 'synthetic', 'ASCII', 'DATASET UNSTRUCTURED_GRID', f'POINTS {len(points)} float']
    lines += [' '.join(repr(c) for c in p) for p in points]
    lines += [f'CELLS {len(cells)} {sum(len(c) + 1 for c in cells)}']
    lines += [' '.join(str(x) for x in [len(c), *c]) for c in cells]
    lines += [f'POINT_DATA {len(points)}', f'FIELD FieldData {len(fields)}']
    for name, rows in fields.items():
        lines.append(f'{name} {len(rows[0])} {len(rows)} float')
        lines += [' '.join(repr(float(v)) for v in row) for row in rows]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(lines) + '\n')


def case_dir(root, name, end_time=1.0):
    d = root / name
    (d / 'vtk_output').mkdir(parents=True)
    (d / 'ProjectParameters.json').write_text(json.dumps({'problem_data': {'end_time': end_time}}))
    return d


def grid(nx, ny, w, h):
    pts = [[w * i / nx, h * j / ny, 0.0] for j in range(ny + 1) for i in range(nx + 1)]
    tris = []
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            tris += [[a, a + 1, a + nx + 2], [a, a + nx + 2, a + nx + 1]]
    return pts, tris


def structural(root):
    d = case_dir(root, 'structural')
    pts, tris = grid(2, 2, 0.018, 0.004)
    reference_m = (0.1 * 4 * 18**4) / (8 * 210000 * (4 * 5**3 / 12)) / 1000
    disp = [[0.0, 0.0, 0.0] for _ in pts]
    disp[-1][2] = reference_m
    write_vtk(d / 'vtk_output' / 'Structure_0_1.vtk', pts, tris, {'DISPLACEMENT': disp, 'VON_MISES_STRESS': [[1.0] for _ in pts]})
    return d


def thermal(root):
    d = case_dir(root, 'thermal')
    pts, tris = grid(4, 2, 1.0, 1.0)
    write_vtk(d / 'vtk_output' / 'T_0_1.vtk', pts, tris, {'TEMPERATURE': [[300 + 100 * p[0]] for p in pts]})
    return d


def potential(root):
    d = case_dir(root, 'potential-flow')
    pts, tris = grid(4, 2, 1.0, 1.0)
    write_vtk(d / 'vtk_output' / 'P_0_1.vtk', pts, tris, {'VELOCITY_POTENTIAL': [[10.2 * p[0]] for p in pts]})
    return d


def shallow(root):
    d = case_dir(root, 'shallow-water')
    pts, tris = grid(4, 4, 2.0, 2.0)
    write_vtk(d / 'vtk_output' / 'S_0_1.vtk', pts, tris, {'HEIGHT': [[1.0] for _ in pts], 'MOMENTUM': [[0.0, 0.0, 0.0] for _ in pts]})
    return d


def fluid(root):
    d = case_dir(root, 'fluid')
    width, height, cx, cy, radius, inlet = 0.2, 0.1, 0.05, 0.05, 0.01, 1.0
    pts, tris = grid(40, 20, width, height)
    pts += [[cx + radius * math.cos(2 * math.pi * k / 32), cy + radius * math.sin(2 * math.pi * k / 32), 0.0] for k in range(32)]
    velocity, pressure = [], []
    for x, y, _ in pts:
        near = math.hypot(x - cx, y - cy) <= radius + 0.0015
        wake = cx + 1.5 * radius <= x <= cx + 5 * radius and abs(y - cy) <= 0.35 * radius
        velocity.append([0.0, 0.0, 0.0] if near else [inlet - (0.1 if wake else 0.0), 0.0, 0.0])
        pressure.append([width - x])
    write_vtk(d / 'vtk_output' / 'F_0_1.vtk', pts, tris, {'VELOCITY': velocity, 'PRESSURE': pressure})
    (d / 'recipe.json').write_text(json.dumps({
        'obstacle': {'widthMm': width * 1000, 'heightMm': height * 1000, 'centerMm': [cx * 1000, cy * 1000], 'radiusMm': radius * 1000},
        'assignments': [{'conditionId': 'inlet', 'values': {'modulus': inlet}}],
        'materials': [{'values': {'DENSITY': 1000.0, 'DYNAMIC_VISCOSITY': 1.0}}]}))
    (d / 'mesh_case.mdpa').write_text(''.join(f'Begin SubModelPart {n}\nEnd SubModelPart\n' for n in ('Domain', 'Inlet', 'Outlet', 'Walls', 'Obstacle')))
    return d


def main():
    built = {'structural': structural, 'thermal': thermal, 'potential-flow': potential, 'shallow-water': shallow, 'fluid': fluid}
    assert set(built) == set(verify.NEGATIVE_CONTROLS), 'a case gained a control without a synthetic fixture (or the reverse)'
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        for case, build in built.items():
            d = build(root)
            report = verify.verify(case, d)                      # the clean data passes, every limit carries a reason
            bounded = [r for r in report['checks'].values() if isinstance(r, dict) and ('maximum' in r or 'minimum' in r)]
            assert bounded and all(r.get('reason') for r in bounded), f'{case}: a limit has no reason'
            control = verify.negative_controls(case, d)          # the perturbed data fails exactly the named check
            assert control['detected'], case
            verify.verify(case, d)                               # and the hook is gone afterwards
            print(f'ok {case}: {control["expected"]}')
        # A limit with no stated reason must be refused.
        saved = verify.LIMIT_REASONS.pop('depth_error_m')
        try:
            verify.verify('shallow-water', root / 'shallow-water')
            raise SystemExit('a limit without a reason was accepted')
        except AssertionError as err:
            assert 'depth_error_m' in str(err)
        finally:
            verify.LIMIT_REASONS['depth_error_m'] = saved
    print('verify self-test passed')


main()
