Virtual wind tunnel (sphere, RANS k-omega SST)

Open sphere.brep in KKSS Pre-Processing (a CAD sphere sidecar-less: the body is one addSphere op). The wizard mesh and case are published as tunnel.mdpa with tunnel.kratosvwt.json (plan + report) and tunnel.kratoscase.json (prepared case).
Run MainKratos.py with Kratos 10.4.3 and the RANS + LinearSolvers applications, using OMP_NUM_THREADS=2.
See https://loumalouomega.github.io/KKSS/guide/tutorial-wind-tunnel

verification.json records solver-produced results and SHA-256 hashes. Values are tutorial checks, not formal solver certification.
Geometry source: cad/examples/BREP/blank.brep; source and derived tutorial assets distributed under KKSS's AGPL-3.0-or-later license.
