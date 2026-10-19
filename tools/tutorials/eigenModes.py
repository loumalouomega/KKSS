#!/usr/bin/env python3
"""Eigenmode shapes of the cantilever tutorial, read from the solver's GiD result
and written as an ASCII VTK file for the viewer.

Why this exists: the eigenvalue run writes its modes to EigenResults/*.post.bin, a
gzip-compressed GiD binary. This build's GiD binary reader misreads the vector
value records (it does not account for the fourth float per node), so the viewer
and the MCP table show most nodes as zero or as another node's value. The raw
records are sound: they are smooth on the mesh, their fourth float is the
displacement magnitude, and their coordinates match the mesh. This script reads the
raw records directly, checks that layout on every block (it stops on any surprise),
and writes the same numbers as VTK for the capture pipeline. Nothing is published
from it; it writes into the generation's scratch folder.

    python3 tools/tutorials/eigenModes.py <generation-dir>/eigen <out.vtu>

Record layout (little endian), established from the file itself:
- coordinates: after the 'Coordinates -1 Indexed' header and one NUL byte,
  records of int32 id + 3 float32 (16 bytes).
- each result block: after 'Values -1 Indexed' and one NUL byte, records of
  int32 id + 3 float32 displacement + float32 magnitude (20 bytes).
"""
import gzip
import math
import pathlib
import re
import struct
import sys
import xml.etree.ElementTree as ET

RESULT_HEADER = re.compile(rb'Result "([^"]+)" "EigenVector_Animation" (\d+) Vector OnNodes')


def read_mdpa(path):
    """Nodes (id -> xyz) and tetrahedra (ids) from a Kratos mdpa file."""
    lines = path.read_text().split('\n')

    def block(name):
        rows, inside, kind = [], False, name.split()[0]
        for line in lines:
            if line.startswith('Begin ' + name):
                inside = True
                continue
            if line.startswith('End ' + kind):
                inside = False
                continue
            if inside and line.strip():
                rows.append(line.split())
        return rows

    nodes = {int(r[0]): tuple(float(v) for v in r[1:4]) for r in block('Nodes')}
    tets = [[int(v) for v in r[2:]] for r in block('Elements Element3D4N')]
    assert nodes and tets, f'{path}: no nodes or tetrahedra'
    return nodes, tets


def read_coordinates(blob):
    """Node ids and float32 coordinates of the GiD 'Coordinates' block."""
    header = blob.find(b'Coordinates -1 Indexed')
    assert header >= 0, 'no Coordinates block'
    base = header + len(b'Coordinates -1 Indexed') + 1
    coords = {}
    for offset in count_iter(blob, base, 16):
        nid = struct.unpack('<i', blob[offset:offset + 4])[0]
        coords[nid] = struct.unpack('<fff', blob[offset + 4:offset + 16])
    return coords


def count_iter(blob, base, size):
    """Yield record offsets while the next int32 id continues the sequence 1, 2, ..."""
    k = 1
    while base + k * size <= len(blob):
        offset = base + (k - 1) * size
        if struct.unpack('<i', blob[offset:offset + 4])[0] != k:
            break
        yield offset
        k += 1


def read_values(blob, start, count):
    """Values of one result block: id -> (ux, uy, uz) and the stored magnitude."""
    base = start + 1
    values = {}
    for index in range(count):
        offset = base + index * 20
        nid = struct.unpack('<i', blob[offset:offset + 4])[0]
        ux, uy, uz, magnitude = struct.unpack('<ffff', blob[offset + 4:offset + 20])
        norm = math.sqrt(ux * ux + uy * uy + uz * uz)
        assert abs(norm - magnitude) <= 1e-6 * max(1.0, norm), f'record {nid}: magnitude {magnitude} is not the norm {norm}'
        values[nid] = (ux, uy, uz)
    return values


def modes_from(blob, node_count):
    modes = []
    for match in RESULT_HEADER.finditer(blob):
        name, step = match.group(1).decode(), int(match.group(2))
        if step != 0 or 'EigenFrequency' not in name:
            continue
        found = blob.find(b'Values -1 Indexed', match.end())
        assert found >= 0, f'{name}: no values block'
        values = read_values(blob, found + len(b'Values -1 Indexed'), node_count)
        mode, frequency = re.match(r'(\d+)_EigenFrequency_\[Hz\]_([\d.]+)_', name).groups()
        modes.append((int(mode), float(frequency), values))
    return sorted(modes, key=lambda m: m[0])


def write_vtu(path, nodes, tets, modes):
    order = sorted(nodes)
    index = {nid: i for i, nid in enumerate(order)}
    points = ' '.join(f'{v:.9g}' for nid in order for v in nodes[nid])
    connectivity = ' '.join(str(index[nid]) for tet in tets for nid in tet)
    offsets = ' '.join(str(4 * (i + 1)) for i in range(len(tets)))
    types = ' '.join('10' for _ in tets)
    fields = ''.join(
        f'<DataArray type="Float32" Name="MODE{mode}_DISPLACEMENT" NumberOfComponents="3" format="ascii">'
        + ' '.join(f'{c:.9g}' for nid in order for c in values[nid]) + '</DataArray>\n'
        for mode, _, values in modes
    )
    text = (
        '<?xml version="1.0"?>\n<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian">\n<UnstructuredGrid>\n'
        f'<Piece NumberOfPoints="{len(order)}" NumberOfCells="{len(tets)}">\n'
        f'<Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">{points}</DataArray></Points>\n'
        f'<Cells>\n<DataArray type="Int64" Name="connectivity" format="ascii">{connectivity}</DataArray>\n'
        f'<DataArray type="Int64" Name="offsets" format="ascii">{offsets}</DataArray>\n'
        f'<DataArray type="UInt8" Name="types" format="ascii">{types}</DataArray>\n</Cells>\n'
        f'<PointData Vectors="MODE{modes[0][0]}_DISPLACEMENT">\n{fields}</PointData>\n'
        '</Piece>\n</UnstructuredGrid>\n</VTKFile>\n'
    )
    ET.fromstring(text)  # the file must be well-formed XML before it is written
    path.write_text(text)


def main(case_dir, out):
    case = pathlib.Path(case_dir)
    results = sorted((case / 'EigenResults').glob('*.post.bin'))
    assert len(results) == 1, f'expected one EigenResults file in {case}, found {len(results)}'
    nodes, tets = read_mdpa(case / 'mesh.mdpa')
    with gzip.open(results[0], 'rb') as handle:
        blob = handle.read()
    coords = read_coordinates(blob)
    assert set(coords) == set(nodes), 'the result file and the mesh name different nodes'
    for nid, xyz in coords.items():
        assert max(abs(a - b) for a, b in zip(xyz, nodes[nid])) < 1e-6, f'node {nid} moved between mesh and result'
    modes = modes_from(blob, len(nodes))
    assert len(modes) == 3, f'expected three eigenmodes, found {len(modes)}'
    for mode, frequency, values in modes:
        print(f'mode {mode}: {frequency:.1f} Hz, max |u| {max(math.dist(v, (0, 0, 0)) for v in values.values()):.5g}')
    out_path = pathlib.Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_vtu(out_path, nodes, tets, modes)
    print(f'wrote {out_path}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
