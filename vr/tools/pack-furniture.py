#!/usr/bin/env python3
"""Bake Sketchfab zig-zag chair + Sony ProFeel into meter-scale GLBs for /vr/models."""
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "3D Assets"
OUT = ROOT / "vr" / "models"


def parse_glb(path):
    data = Path(path).read_bytes()
    off = 12
    j = bindata = None
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        if ctype == 0x4E4F534A:
            j = json.loads(data[off : off + clen])
        elif ctype == 0x004E4942:
            bindata = data[off : off + clen]
        off += clen
    return j, bindata


def mat4(m):
    return np.array(m, dtype=np.float64).reshape(4, 4, order="F")


def node_worlds(j):
    nodes = j["nodes"]
    found = []

    def walk(idx, parent):
        n = nodes[idx]
        local = mat4(n["matrix"]) if "matrix" in n else np.eye(4)
        world = parent @ local
        if "mesh" in n:
            found.append((n["mesh"], world, n.get("name")))
        for c in n.get("children", []):
            walk(c, world)

    walk(j["scenes"][j.get("scene", 0)]["nodes"][0], np.eye(4))
    return found


def read_acc(j, bindata, idx):
    a = j["accessors"][idx]
    bv = j["bufferViews"][a["bufferView"]]
    o = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a["componentType"]]
    arr = np.frombuffer(bindata, dtype=dt, count=a["count"] * comps, offset=o)
    return arr.reshape(a["count"], comps).copy()


def image_blob(j, bindata, i, max_size=None, jpeg=False, jpeg_q=86):
    im = j["images"][i]
    bv = j["bufferViews"][im["bufferView"]]
    blob = bindata[bv.get("byteOffset", 0) : bv.get("byteOffset", 0) + bv["byteLength"]]
    if max_size is None and not jpeg:
        return blob, im.get("mimeType", "image/png")
    img = Image.open(io.BytesIO(blob))
    if max_size and max(img.size) > max_size:
        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    if jpeg:
        img = img.convert("RGB")
        img.save(buf, format="JPEG", quality=jpeg_q, optimize=True)
        return buf.getvalue(), "image/jpeg"
    if img.mode == "P":
        img = img.convert("RGB")
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), "image/png"


def xform_mesh(pos, nrm, tan, world, extra=None):
    hom = np.c_[pos.astype(np.float64), np.ones(len(pos))]
    pos_w = (hom @ world.T)[:, :3]
    R = world[:3, :3]
    try:
        N = np.linalg.inv(R).T
    except np.linalg.LinAlgError:
        N = R
    nrm_w = nrm.astype(np.float64) @ N.T
    lens = np.linalg.norm(nrm_w, axis=1, keepdims=True)
    lens[lens < 1e-12] = 1
    nrm_w /= lens
    tan_w = None
    if tan is not None:
        txyz = tan[:, :3].astype(np.float64) @ R.T
        tl = np.linalg.norm(txyz, axis=1, keepdims=True)
        tl[tl < 1e-12] = 1
        txyz /= tl
        tan_w = np.c_[txyz, tan[:, 3]]
    if extra is not None:
        pos_w, nrm_w, tan_w = extra(pos_w, nrm_w, tan_w)
    return pos_w.astype(np.float32), nrm_w.astype(np.float32), None if tan_w is None else tan_w.astype(np.float32)


def write_glb(path, meshes, materials, images, samplers=None):
    """meshes: list of dicts with pos,nrm,uv,idx,tan?, material index, name"""
    chunks, views, accessors, prims_by_mesh = [], [], [], []

    def add(raw, target=None):
        pad = (4 - len(raw) % 4) % 4
        off = sum(len(c) for c in chunks)
        chunks.append(raw + b"\x00" * pad)
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(raw)}
        if target is not None:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    mesh_json = []
    for m in meshes:
        attrs = {}
        pos = np.ascontiguousarray(m["pos"], dtype=np.float32)
        pi = add(pos.tobytes(), 34962)
        attrs["POSITION"] = len(accessors)
        accessors.append(
            {
                "bufferView": pi,
                "componentType": 5126,
                "count": len(pos),
                "type": "VEC3",
                "min": pos.min(0).tolist(),
                "max": pos.max(0).tolist(),
            }
        )
        nrm = np.ascontiguousarray(m["nrm"], dtype=np.float32)
        ni = add(nrm.tobytes(), 34962)
        attrs["NORMAL"] = len(accessors)
        accessors.append({"bufferView": ni, "componentType": 5126, "count": len(nrm), "type": "VEC3"})
        if m.get("tan") is not None:
            tan = np.ascontiguousarray(m["tan"], dtype=np.float32)
            ti = add(tan.tobytes(), 34962)
            attrs["TANGENT"] = len(accessors)
            accessors.append({"bufferView": ti, "componentType": 5126, "count": len(tan), "type": "VEC4"})
        if m.get("uv") is not None:
            uv = np.ascontiguousarray(m["uv"], dtype=np.float32)
            ui = add(uv.tobytes(), 34962)
            attrs["TEXCOORD_0"] = len(accessors)
            accessors.append({"bufferView": ui, "componentType": 5126, "count": len(uv), "type": "VEC2"})
        idx = m["idx"].astype(np.uint16 if m["idx"].max() < 65536 else np.uint32)
        ii = add(idx.tobytes(), 34963)
        accessors.append(
            {
                "bufferView": ii,
                "componentType": 5123 if idx.dtype == np.uint16 else 5125,
                "count": int(idx.size),
                "type": "SCALAR",
            }
        )
        mesh_json.append(
            {
                "name": m.get("name", "mesh"),
                "primitives": [
                    {
                        "attributes": attrs,
                        "indices": len(accessors) - 1,
                        "material": m["material"],
                        "mode": 4,
                    }
                ],
            }
        )

    img_json = []
    for blob, mime, name in images:
        ii = add(blob)
        img_json.append({"bufferView": ii, "mimeType": mime, "name": name})

    bin_blob = b"".join(chunks)
    nodes = [{"mesh": i, "name": mesh_json[i]["name"]} for i in range(len(mesh_json))]
    if len(nodes) > 1:
        root = {"name": "root", "children": list(range(1, 1 + len(nodes)))}
        gltf_nodes = [root] + nodes
        # shift mesh indices: nodes 1..n have meshes 0..n-1 — already mesh:i on nodes list
        # children of root should point to node indices 1..n
        scene_nodes = [0]
        # fix: nodes currently [{mesh:0},{mesh:1}] then we prepend root
        gltf_nodes = [{"name": "root", "children": list(range(1, 1 + len(nodes)))}]
        gltf_nodes.extend({"mesh": i, "name": mesh_json[i]["name"]} for i in range(len(mesh_json)))
        scene_nodes = [0]
    else:
        gltf_nodes = nodes
        scene_nodes = [0]

    gltf = {
        "asset": {"version": "2.0", "generator": "ingysynth-pack"},
        "scene": 0,
        "scenes": [{"nodes": scene_nodes}],
        "nodes": gltf_nodes,
        "meshes": mesh_json,
        "materials": materials,
        "textures": [{"sampler": 0, "source": i} for i in range(len(img_json))],
        "images": img_json,
        "samplers": samplers
        or [
            {
                "magFilter": 9729,
                "minFilter": 9987,
                "wrapS": 10497,
                "wrapT": 10497,
            }
        ],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(bin_blob)}],
    }
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode()
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    bin_blob += b"\x00" * ((4 - len(bin_blob) % 4) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_blob)
    path.write_bytes(
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
        + struct.pack("<II", len(bin_blob), 0x004E4942)
        + bin_blob
    )
    print("wrote", path, total)


def pack_chair():
    j, bindata = parse_glb(ASSETS / "zig-zag_chair.glb")
    worlds = {mesh: W for mesh, W, name in node_worlds(j)}

    def load_prim(mi):
        pr = j["meshes"][mi]["primitives"][0]
        pos = read_acc(j, bindata, pr["attributes"]["POSITION"])
        nrm = read_acc(j, bindata, pr["attributes"]["NORMAL"])
        uv = read_acc(j, bindata, pr["attributes"]["TEXCOORD_0"])
        tan = read_acc(j, bindata, pr["attributes"]["TANGENT"]) if "TANGENT" in pr["attributes"] else None
        idx = read_acc(j, bindata, pr["indices"]).reshape(-1)
        return pos, nrm, tan, uv, idx

    def to_meters_then_sit(pos, nrm, tan):
        pos = pos * 0.01
        return pos, nrm, tan

    pos0, nrm0, tan0, uv0, idx0 = load_prim(0)
    pos0, nrm0, tan0 = xform_mesh(pos0, nrm0, tan0, worlds[0], to_meters_then_sit)
    pos1, nrm1, tan1, uv1, idx1 = load_prim(1)
    pos1, nrm1, tan1 = xform_mesh(pos1, nrm1, tan1, worlds[1], to_meters_then_sit)

    cx = float((pos0[:, 0].min() + pos0[:, 0].max()) * 0.5)
    ymin = float(min(pos0[:, 1].min(), pos1[:, 1].min()))

    def sit_yaw(pos, nrm, tan):
        pos = pos.copy()
        nrm = nrm.copy()
        pos[:, 0] -= cx
        pos[:, 1] -= ymin
        # 180° yaw: backrest was -Z, player looks -Z at the desk
        pos[:, 0] *= -1
        pos[:, 2] *= -1
        nrm[:, 0] *= -1
        nrm[:, 2] *= -1
        if tan is not None:
            tan = tan.copy()
            tan[:, 0] *= -1
            tan[:, 2] *= -1
        return pos, nrm, tan

    pos0, nrm0, tan0 = sit_yaw(pos0.astype(np.float64), nrm0.astype(np.float64), None if tan0 is None else tan0.astype(np.float64))
    pos1, nrm1, tan1 = sit_yaw(pos1.astype(np.float64), nrm1.astype(np.float64), None if tan1 is None else tan1.astype(np.float64))

    hi = pos0[pos0[:, 1] > 0.55]
    seat = pos0[(pos0[:, 1] > 0.32) & (pos0[:, 1] < 0.48)]
    print(
        "chair m bbox",
        pos0.min(0).round(3),
        pos0.max(0).round(3),
        "backrest z",
        hi[:, 2].mean().round(3) if len(hi) else None,
        "seat z",
        seat[:, 2].mean().round(3) if len(seat) else None,
        "place z",
        round(0.18 - float(seat[:, 2].mean()), 3) if len(seat) else None,
    )

    imgs = [
        (*image_blob(j, bindata, 0), "wood-d"),
        (*image_blob(j, bindata, 1), "wood-mr"),
        (*image_blob(j, bindata, 2), "wood-n"),
        (*image_blob(j, bindata, 3, max_size=256, jpeg=True), "nut-d"),
        (*image_blob(j, bindata, 4, max_size=256), "nut-mr"),
    ]
    mats = [
        {
            "name": "Wood",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "metallicFactor": 0,
                "metallicRoughnessTexture": {"index": 1},
            },
            "normalTexture": {"index": 2, "scale": 0.4},
        },
        {
            "name": "Nuts",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 3},
                "metallicRoughnessTexture": {"index": 4},
            },
        },
    ]
    write_glb(
        OUT / "zigzag-chair.glb",
        [
            {"name": "chair", "pos": pos0, "nrm": nrm0, "tan": tan0, "uv": uv0, "idx": idx0, "material": 0},
            {"name": "nuts", "pos": pos1, "nrm": nrm1, "tan": tan1, "uv": uv1, "idx": idx1, "material": 1},
        ],
        mats,
        imgs,
    )


def pack_sony():
    j, bindata = parse_glb(ASSETS / "sony_trinitron_profeel_pro.glb")
    worlds = {mesh: W for mesh, W, name in node_worlds(j)}
    pr = j["meshes"][0]["primitives"][0]
    pos = read_acc(j, bindata, pr["attributes"]["POSITION"])
    nrm = read_acc(j, bindata, pr["attributes"]["NORMAL"])
    tan = read_acc(j, bindata, pr["attributes"]["TANGENT"])
    uv = read_acc(j, bindata, pr["attributes"]["TEXCOORD_0"])
    idx = read_acc(j, bindata, pr["indices"]).reshape(-1)
    pos, nrm, tan = xform_mesh(pos, nrm, tan, worlds[0])

    size = pos.max(0) - pos.min(0)
    s = 0.50 / float(size[0])  # 50cm cabinet width
    pos = pos * s
    cx = float((pos[:, 0].min() + pos[:, 0].max()) * 0.5)
    cz = float((pos[:, 2].min() + pos[:, 2].max()) * 0.5)
    ymin = float(pos[:, 1].min())
    pos[:, 0] -= cx
    pos[:, 1] -= ymin
    pos[:, 2] -= cz

    front = nrm[:, 2] > 0.55
    fp = pos[front]
    print("sony m bbox", pos.min(0).round(4), pos.max(0).round(4), "size", (pos.max(0) - pos.min(0)).round(4))
    print("front n", int(front.sum()), "xy", fp[:, :2].min(0).round(4), fp[:, :2].max(0).round(4), "z", fp[:, 2].mean().round(4))
    # CRT inset on the ProFeel face (controls live on the right)
    w, h, d = (pos.max(0) - pos.min(0))
    screen = {
        "w": round(float(w * 0.58), 4),
        "h": round(float(h * 0.50), 4),
        "x": round(float(-w * 0.06), 4),
        "y": round(float(h * 0.54), 4),
        "z": round(float(pos[:, 2].max() + 0.002), 4),
    }
    print("SCREEN", json.dumps(screen))

    imgs = [
        (*image_blob(j, bindata, 0), "d"),
        (*image_blob(j, bindata, 1), "mr"),
        (*image_blob(j, bindata, 2), "n"),
    ]
    mats = [
        {
            "name": "profeel",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "metallicRoughnessTexture": {"index": 1},
                "roughnessFactor": 0.35,
                "metallicFactor": 0.15,
            },
            "normalTexture": {"index": 2},
        }
    ]
    write_glb(
        OUT / "sony-profeel.glb",
        [{"name": "profeel", "pos": pos, "nrm": nrm, "tan": tan, "uv": uv, "idx": idx, "material": 0}],
        mats,
        imgs,
        samplers=[
            {
                "magFilter": 9729,
                "minFilter": 9987,
                "wrapS": 33071,
                "wrapT": 33071,
            }
        ],
    )


TOLOMEO_SKIP = {
    # Duplicate shade shell — same volume as Line001, causes z-fighting / strobing.
    "Object008",
    # Balance cables span two rig segments; drawn live in tolomeo.js instead.
    "Line017",
    "Line018",
}

# Black hardware: pivot pins, yoke knobs, socket cup.
TOLOMEO_DARK = {
    "Circle007", "Circle014", "Circle010", "Circle011", "Circle013",
    "Circle012", "Shape001", "Cylinder001",
    "Circle003", "Circle004", "Object005", "Object006", "Obj_000008",
}

# One group per rigid segment of the real mechanism.
TOLOMEO_GROUPS = {
    # Weighted base disc — never moves.
    "disc": ["Object007"],
    # Stem + knuckle + base cable lever: spins in the disc socket.
    "stem": ["Line012", "Line013", "Circle006", "Line015", "Line011", "Circle007"],
    # Lower arm + rear half of the elbow bracket (cable anchors live here).
    "lower": [
        "Line014", "Circle014", "Line016", "SShape001_L",
        "Circle010", "Circle011", "Circle013", "Line010",
    ],
    # Upper arm: elbow knuckle + front half of the bracket + tube.
    "upper": ["Circle008", "Circle012", "Shape001", "SShape001_R", "Line007"],
    # Neck, yoke, knobs, shade ring and socket.
    "head": [
        "Circle005", "Line008", "Line034", "Object004", "Cylinder001",
        "Circle002", "Line002", "Line003", "Line004",
        "Circle003", "Circle004", "Object005", "Object006",
        "Circle001", "Shape002", "Obj_000008",
    ],
    # Shade is its own mesh so it can be depth-offset against the housing.
    "shade": ["Line001"],
    # Pull-down handle hanging from the shade rim.
    "handle": ["Line005"],
}

# The CAD models the elbow bracket as one S-shaped plate running from the
# lower-arm top, through the knuckle, into the upper-arm tube. Split it at
# the knuckle centre (x, metres, disc-centred) so each half rides its own arm.
TOLOMEO_SPLIT = {
    "SShape001": ("SShape001_L", "SShape001_R", -0.0626),
}


def pack_tolomeo():
    j, bindata = parse_glb(ASSETS / "Tolomeo table.glb")
    name_of = {}
    for n in j["nodes"]:
        if "mesh" not in n:
            continue
        raw = n.get("name") or ""
        name_of[n["mesh"]] = raw.replace("g ", "").strip() or f"mesh{n['mesh']}"

    parts = {}
    for mi, mesh in enumerate(j["meshes"]):
        pr = mesh["primitives"][0]
        pos = read_acc(j, bindata, pr["attributes"]["POSITION"])
        nrm = read_acc(j, bindata, pr["attributes"]["NORMAL"])
        if "indices" in pr:
            idx = read_acc(j, bindata, pr["indices"]).reshape(-1)
        else:
            idx = np.arange(len(pos), dtype=np.uint32)
        uv = (
            read_acc(j, bindata, pr["attributes"]["TEXCOORD_0"])
            if "TEXCOORD_0" in pr["attributes"]
            else None
        )
        parts[name_of[mi]] = {"pos": pos, "nrm": nrm, "uv": uv, "idx": idx}

    base = parts["Object007"]["pos"]
    base_cx = float((base[:, 0].min() + base[:, 0].max()) * 0.5)
    scale = 0.001

    def xform(pos, nrm):
        p = pos.astype(np.float64) * scale
        p[:, 0] -= base_cx * scale
        return p.astype(np.float32), nrm.astype(np.float32)

    def clip_half(part, side_of, cut_mm):
        """Clip every triangle of `part` to one side of the plane x = cut_mm.

        side_of(x) -> True for the kept half-space. Crossing triangles are
        split exactly on the plane so nothing pokes through after rotation.
        """
        pos = part["pos"].astype(np.float64)
        nrm = part["nrm"].astype(np.float64)
        tris = part["idx"].reshape(-1, 3)
        out_p, out_n, out_i = [], [], []

        def emit(vs):
            base_i = sum(len(p) for p in out_p)
            out_p.append(np.array([v[0] for v in vs]))
            out_n.append(np.array([v[1] for v in vs]))
            for k in range(1, len(vs) - 1):
                out_i.extend((base_i, base_i + k, base_i + k + 1))

        for a, b, c in tris:
            corners = [(pos[a], nrm[a]), (pos[b], nrm[b]), (pos[c], nrm[c])]
            inside = [side_of(v[0][0]) for v in corners]
            if all(inside):
                emit(corners)
                continue
            if not any(inside):
                continue
            poly = []
            for k in range(3):
                p0, n0 = corners[k]
                p1, n1 = corners[(k + 1) % 3]
                in0, in1 = inside[k], inside[(k + 1) % 3]
                if in0:
                    poly.append((p0, n0))
                if in0 != in1:
                    t = (cut_mm - p0[0]) / (p1[0] - p0[0])
                    poly.append((p0 + (p1 - p0) * t, n0 + (n1 - n0) * t))
            if len(poly) >= 3:
                emit(poly)

        return {
            "pos": np.concatenate(out_p).astype(np.float32),
            "nrm": np.concatenate(out_n).astype(np.float32),
            "uv": None,
            "idx": np.array(out_i, dtype=np.uint32),
        }

    for src, (left, right, cut_x) in TOLOMEO_SPLIT.items():
        cut_mm = cut_x / scale + base_cx
        parts[left] = clip_half(parts[src], lambda x: x < cut_mm, cut_mm)
        parts[right] = clip_half(parts[src], lambda x: x >= cut_mm, cut_mm)
        print(
            "tolomeo split", src, "->", left, len(parts[left]["pos"]),
            "|", right, len(parts[right]["pos"]),
        )

    def merge(names):
        ps, ns, us, ixs = [], [], [], []
        off = 0
        for name in names:
            p = parts[name]
            pos, nrm = xform(p["pos"], p["nrm"])
            ps.append(pos)
            ns.append(nrm)
            if p["uv"] is not None:
                us.append(p["uv"].astype(np.float32))
            ixs.append(p["idx"].astype(np.uint32) + off)
            off += len(pos)
        out = {
            "pos": np.concatenate(ps),
            "nrm": np.concatenate(ns),
            "idx": np.concatenate(ixs),
            "uv": None,
            "tan": None,
        }
        if us and sum(len(u) for u in us) == len(out["pos"]):
            out["uv"] = np.concatenate(us)
        return out

    packed = {}
    for group, names in TOLOMEO_GROUPS.items():
        keep = [n for n in names if n not in TOLOMEO_SKIP]
        alu = [n for n in keep if n not in TOLOMEO_DARK]
        dark = [n for n in keep if n in TOLOMEO_DARK]
        if alu:
            packed[group] = (merge(alu), 0)
        if dark:
            packed[f"{group}_dark"] = (merge(dark), 1)
    for group, (m, _) in packed.items():
        print(
            "tolomeo",
            group,
            "verts",
            len(m["pos"]),
            "bbox",
            m["pos"].min(0).round(3),
            m["pos"].max(0).round(3),
        )

    def bbox_center(name):
        pos, _ = xform(parts[name]["pos"], parts[name]["nrm"])
        return ((pos.min(0) + pos.max(0)) * 0.5).round(4).tolist()

    def end(name, axis, low):
        pos, _ = xform(parts[name]["pos"], parts[name]["nrm"])
        v = pos[:, axis]
        sel = v < v.min() + 0.002 if low else v > v.max() - 0.002
        return pos[sel].mean(0).round(4).tolist()

    stem_c = bbox_center("Line013")
    print("tolomeo stem axis xz", [stem_c[0], stem_c[2]])
    print("pivot shoulder (knuckle Circle006)", bbox_center("Circle006"))
    print("pivot elbow (knuckle Circle008)", bbox_center("Circle008"))
    print("pivot wrist (pin Circle005)", bbox_center("Circle005"))
    print("base cable  stem->bracket", end("Line018", 1, True), end("Line018", 1, False))
    print("head cable  bracket->head", end("Line017", 0, True), end("Line017", 0, False))

    shade_pos, _ = xform(parts["Line001"]["pos"], parts["Line001"]["nrm"])
    shade_pos = shade_pos.astype(np.float64)
    c = shade_pos.mean(0)
    _, _, vt = np.linalg.svd(shade_pos - c, full_matrices=False)
    axis = vt[0] / np.linalg.norm(vt[0])
    if axis[1] < 0:
        axis = -axis
    proj = (shade_pos - c) @ axis
    print("shade centroid", c.round(4).tolist(), "axis rim->apex", axis.round(4).tolist(),
          "rim proj", round(float(proj.min()), 4), "apex proj", round(float(proj.max()), 4))

    mats = [
        {
            "name": "aluminum",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.72, 0.74, 0.76, 1],
                "metallicFactor": 0.85,
                "roughnessFactor": 0.28,
            },
        },
        {
            "name": "black",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.06, 0.06, 0.065, 1],
                "metallicFactor": 0.2,
                "roughnessFactor": 0.55,
            },
        },
    ]
    write_glb(
        OUT / "tolomeo.glb",
        [
            {"name": group, **mesh, "tan": None, "material": mat}
            for group, (mesh, mat) in packed.items()
        ],
        mats,
        [],
    )


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    pack_chair()
    pack_sony()
    pack_tolomeo()
