Two-fluid dam break (level set)

Open tank.brep in KKSS Pre-Processing. Sidecars replay the documented geometry edits and named Parts.
Open mesh.mdpa in Post-Processing for the saved Problemtype setup.
Before the run, create navier_stokes_two_fluid_solver.py in the KratosMultiphysics/FluidDynamicsApplication package directory with the single line: from KratosMultiphysics.FluidDynamicsApplication.navier_stokes_two_fluids_solver import *
The serial two-fluid wrapper of Kratos 10.4.3 asks for the singular module name; the package ships the plural one.
Run MainKratos.py with Kratos 10.4.3 and the required application, using OMP_NUM_THREADS=2.
See https://loumalouomega.github.io/KKSS/guide/tutorial-two-fluids

verification.json records solver-produced results and SHA-256 hashes. Values are tutorial checks, not formal solver certification.
Geometry source: cad/examples/BREP/blank.brep; source and derived tutorial assets distributed under KKSS's AGPL-3.0-or-later license.
