// Parametric L-bracket with a mounting hole.
//
// Every assignment below is an OpenSCAD Customizer parameter: the CAD
// viewer's Customizer panel lists them, the assistant's
// `list_scad_parameters` reads them from this text alone, and applying a
// value persists it to `bracket.scad-params.json` and replays it as a `-D`
// define on every later conversion. The source file itself is never written.

// Footprint of the base, in mm.
base_w = 60;      // [20:100]
base_d = 40;      // [10:80]
// Upright height and the wall thickness of both legs, in mm.
height = 40;      // [10:80]
thickness = 6;    // [2:12]
// Mounting-hole diameter in the base, in mm.
hole_d = 8;       // [3:20]

difference() {
    union() {
        cube([base_w, base_d, thickness]);
        translate([0, 0, 0]) cube([thickness, base_d, height]);
    }
    translate([base_w / 2, base_d / 2, -1])
        cylinder(h = thickness + 2, d = hole_d, $fn = 48);
}
