# Worked Kratos cases

These three small cases include their MDPA mesh, materials, solver parameters,
runner, and VTK output from a completed Kratos solve. They start from an MDPA
case so you can inspect real result fields in KKSS without first building a
geometry or mesh.

For the full CAD-to-solver workflow, see [Geometry to results](/guide/tutorial-geometry-to-results).

The cases were rerun with Python 3.12 and Kratos Multiphysics 10.4.3 on Linux
x86-64, using two OpenMP threads. The checked-in VTK files are the solver output
from those runs. Each `MainKratos.py` reads the adjacent `ProjectParameters.json`
and runs its AnalysisStage (or Kratos' sequential orchestrator for the staged
case).

To rerun a case, download or copy its directory to a writable location, then
run it with a Python interpreter that can import the Kratos applications named
in its parameters:

```sh
cd cantilever
python MainKratos.py
```

If you manage that interpreter with uv, select the existing Kratos Python
explicitly:

```sh
uv run --python /path/to/kratos/python --no-project python MainKratos.py
```

`uv` provides the runner; it does not by itself install Kratos or its
applications. In KKSS, open `mesh.mdpa` in Post-Processing, run
`MainKratos.py` from the embedded terminal, then open the generated VTK file to
inspect the result. The supplied result file can be opened directly without
rerunning.

## Structural cantilever

This two-dimensional plane-strain model has 10 nodes and four quadrilateral
elements. Its `left` SubModelPart is fixed, and its `right` SubModelPart carries
a downward line load of 1 MN/m. The final VTK result reports a maximum vertical
displacement of `-0.25312169 mm` at the free edge. The model uses SI units.

- [Mesh](/examples/kratos/cantilever/mesh.mdpa)
- [Materials](/examples/kratos/cantilever/Materials.json)
- [Project parameters](/examples/kratos/cantilever/ProjectParameters.json)
- [MainKratos.py](/examples/kratos/cantilever/MainKratos.py)
- [Solver-produced VTK result](/examples/kratos/cantilever/vtk_output/Structure_0_1.vtk)

## Lid-driven cavity

This two-dimensional monolithic fluid case has 121 nodes and 200 elements. Its
included final output is at time 30 and contains `VELOCITY` and `PRESSURE`
fields; the measured maximum speed in that result is `1.0` in the case's
velocity units.

- [Mesh](/examples/kratos/lid_driven_cavity/mesh.mdpa)
- [Materials](/examples/kratos/lid_driven_cavity/Materials.json)
- [Project parameters](/examples/kratos/lid_driven_cavity/ProjectParameters.json)
- [MainKratos.py](/examples/kratos/lid_driven_cavity/MainKratos.py)
- [Final VTK result](/examples/kratos/lid_driven_cavity/vtk_output/FluidModelPart_0_30.vtk)

## Two-stage structural load

This structural case has two stages on the same 55-node, 40-element mesh. The
second stage doubles the line load. The solver-produced results show maximum
vertical displacement magnitudes of `0.39978517 mm` and `0.79957047 mm` for
stages one and two.

- [Mesh](/examples/kratos/multistage_load_steps/mesh.mdpa)
- [Materials](/examples/kratos/multistage_load_steps/Materials.json)
- [Project parameters](/examples/kratos/multistage_load_steps/ProjectParameters.json)
- [MainKratos.py](/examples/kratos/multistage_load_steps/MainKratos.py)
- [Stage one result](/examples/kratos/multistage_load_steps/vtk_stage_1/Structure_0_1.vtk)
- [Stage two result](/examples/kratos/multistage_load_steps/vtk_stage_2/Structure_0_1.vtk)

The case inputs are from `kratos-mcp-server` 0.3.0; its MIT license and
attribution are included in `doc/public/examples/kratos/`. The reported results
are generated output, not analytical references or a claim of formal solver
validation.
