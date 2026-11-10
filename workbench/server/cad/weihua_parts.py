"""Parametric parts for the Weihua workbench, built with build123d (text-to-cad).

Every function takes plain numbers in millimetres and returns a build123d Shape.
Coordinates: X is the coil / part axis, Y across, Z up, part standing on Z = 0.
build(spec) is the single entry point the job scripts call.
"""
import math

import build123d as bd

STEEL = "#5b6f84"
RUBBER = "#1f2329"
COIL = "#aeb4ba"
RACK_BLUE = "#1f5fa8"
RACK_ORANGE = "#e8731c"


def _section_extrude(points, length):
    """Polygon in the YZ plane (local x = Y, local y = Z) extruded along X, centred."""
    face = bd.Plane.YZ * bd.Polygon(*points, align=None)
    return bd.extrude(face, amount=length / 2, both=True)


def saddle_v(length=1400, width=1200, height=450, base_t=40, groove_angle=90, min_t=120, pad_t=20):
    """V-type coil saddle: base plate, a block with a V groove along X, rubber pads on the flanks."""
    # width/length are the overall footprint (= the base plate); the grooved block sits 50 mm inside it
    half = math.radians(groove_angle / 2)
    block_half = width / 2 - 50
    depth = max(10.0, height - base_t - min_t)
    top_half = min(depth * math.tan(half), block_half - 40)
    depth = top_half / math.tan(half)
    apex = height - depth
    section = [(-block_half, base_t), (block_half, base_t), (block_half, height), (top_half, height),
               (0, apex), (-top_half, height), (-block_half, height)]
    body = _section_extrude(section, length * 0.8)
    base = bd.Box(length, width, base_t, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    saddle = base + body
    saddle.color = bd.Color(STEEL)
    saddle.label = "saddle"
    parts = [saddle]
    if pad_t > 0:
        flank = math.hypot(top_half, depth)
        for side in (-1, 1):
            # thin rubber strip lying on each flank of the V, pushed out along the flank's normal
            angle = math.degrees(math.atan2(depth, side * top_half))
            ny, nz = -side * depth / flank, top_half / flank
            cy = side * top_half / 2 + ny * pad_t / 2
            cz = apex + depth / 2 + nz * pad_t / 2
            pad = bd.Pos(0, cy, cz) * bd.Rot(angle, 0, 0) * bd.Box(length * 0.7, flank * 0.7, pad_t)
            pad.color = bd.Color(RUBBER)
            pad.label = f"pad_{'l' if side < 0 else 'r'}"
            parts.append(pad)
    return bd.Compound(children=parts, label="saddle_v")


def saddle_cradle(length=1400, width=1300, height=500, base_t=40, coil_d=1600, min_t=120):
    """Arc (cradle) saddle: the top is cut by the coil's own cylinder so the coil sits on a curved seat."""
    r = coil_d / 2
    seat_depth = max(20.0, min(height - base_t - min_t, r * (1 - math.cos(math.radians(40)))))
    block = bd.Pos(0, 0, base_t) * bd.Box(length * 0.8, width - 100, height - base_t, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    cut = bd.Pos(0, 0, height - seat_depth + r) * bd.Rot(0, 90, 0) * bd.Cylinder(r, length * 2)
    base = bd.Box(length, width, base_t, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    body = base + block - cut
    body.color = bd.Color(STEEL)
    body.label = "saddle_cradle"
    return body


def coil(diameter=1600, eye=600, width=1350):
    """Steel coil lying with its axis along X, resting on Z = 0."""
    r = diameter / 2
    shell = bd.Pos(0, 0, r) * bd.Rot(0, 90, 0) * (bd.Cylinder(r, width) - bd.Cylinder(eye / 2, width * 1.1))
    shell.color = bd.Color(COIL)
    shell.label = "coil"
    return shell


def rack(bays=3, levels=4, bay_width=2700, depth=1100, level_height=1500, upright=90, beam_h=120, first_level=200):
    """Selective pallet rack: blue uprights, orange beams, one frame per bay boundary."""
    parts = []
    total_w = bays * bay_width
    top = first_level + (levels - 1) * level_height + beam_h + 300
    x0 = -total_w / 2
    for i in range(bays + 1):
        x = x0 + i * bay_width
        for y in (-depth / 2, depth / 2):
            post = bd.Pos(x, y, 0) * bd.Box(upright, upright, top, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
            post.color = bd.Color(RACK_BLUE)
            parts.append(post)
        brace = bd.Pos(x, 0, top / 2) * bd.Box(upright * 0.4, depth, 40)
        brace.color = bd.Color(RACK_BLUE)
        parts.append(brace)
    for level in range(levels):
        z = first_level + level * level_height
        for b in range(bays):
            cx = x0 + (b + 0.5) * bay_width
            for y in (-depth / 2, depth / 2):
                beam = bd.Pos(cx, y, z) * bd.Box(bay_width - upright, 50, beam_h, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
                beam.color = bd.Color(RACK_ORANGE)
                parts.append(beam)
    return bd.Compound(children=parts, label="rack")


def pallet(length=1200, width=1000, height=150):
    """Simple 3-runner pallet."""
    deck = bd.Pos(0, 0, height - 25) * bd.Box(length, width, 25, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    runners = [bd.Pos(0, y, 0) * bd.Box(length, 100, height - 25, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
               for y in (-width / 2 + 50, 0, width / 2 - 50)]
    body = deck
    for runner in runners:
        body = body + runner
    body.color = bd.Color("#b08a5a")
    body.label = "pallet"
    return body


def primitives(items):
    """Boxes and cylinders combined in order: op 'add' unions, op 'cut' subtracts."""
    body = None
    for item in items:
        shape = item.get("shape", "box")
        if shape == "cylinder":
            solid = bd.Cylinder(item["radius"], item["height"])
        else:
            sx, sy, sz = item["size"]
            solid = bd.Box(sx, sy, sz)
        rx, ry, rz = item.get("rot", [0, 0, 0])
        px, py, pz = item.get("pos", [0, 0, 0])
        solid = bd.Pos(px, py, pz) * bd.Rot(rx, ry, rz) * solid
        if body is None:
            body = solid
        elif item.get("op") == "cut":
            body = body - solid
        else:
            body = body + solid
    body.color = bd.Color(item_color(items))
    body.label = "part"
    return body


def item_color(items):
    for item in items:
        if isinstance(item.get("color"), str) and len(item["color"]) == 7 and item["color"].startswith("#"):
            return item["color"]
    return STEEL


def profile(points, depth, holes=(), axis="x"):
    """A drawn outline (mm, already centred) extruded by depth.

    axis 'x': the outline is a side view (drawing x -> Y, drawing y -> Z), extruded along X (saddles, brackets).
    axis 'z': the outline is a plan view, extruded upwards (plates, bases).
    """
    plane = bd.Plane.YZ if axis == "x" else bd.Plane.XY
    face = plane * bd.Polygon(*[tuple(p) for p in points], align=None)
    for hole in holes:
        if len(hole) >= 3:
            face = face - plane * bd.Polygon(*[tuple(p) for p in hole], align=None)
    body = bd.extrude(face, amount=depth / 2, both=True) if axis == "x" else bd.extrude(face, amount=depth)
    body.color = bd.Color(STEEL)
    body.label = "profile_part"
    return body


TEMPLATES = {
    "saddle_v": saddle_v,
    "saddle_cradle": saddle_cradle,
    "coil": coil,
    "rack": rack,
    "pallet": pallet,
}


def build(spec):
    template = spec["template"]
    params = spec.get("params", {})
    if template == "primitives":
        return primitives(params["items"])
    if template == "profile":
        return profile(params["points"], params["depth"], params.get("holes", []), params.get("axis", "x"))
    return TEMPLATES[template](**params)
