"""Convert the sculpted TectonicSeabed FBX into a GLB the 8th Wall runtime can load.

The engine has no FBX loader -- `ecs.GltfModel` takes a .glb/.gltf URL and nothing
else -- so the sculpt has to be converted before it can be spawned. Rather than
doing that by hand in Blender every time the sculpt is re-exported, this script
does the whole pass headlessly:

    1. import the FBX
    2. decimate it to something a phone can actually draw (the raw sculpt is
       ~600k triangles; a WebAR scene wants tens of thousands)
    3. scale it into the project's *block units* -- 1 unit = the width of the
       printed image target = 100 mm -- so it drops straight under Seabed Root
       next to the hand-authored geometry
    4. build the vertex mask that drives the volume expansion, either from a
       vertex group already present in the source or from a radial falloff
    5. bake that mask two ways:
         - an "Expand" shape key -> a glTF morph target, which is all the runtime
           needs for `position += normal * mask * amount` (see below)
         - a `_mask` float attribute -> glTF `_MASK`, for shaders that want to do
           something non-linear with it
    6. export a Draco-compressed GLB (the runtime ships a Draco decoder)

Usage -- Blender is not on PATH on Windows, so give the full path:

    blender.exe -b --factory-startup -noaudio -P tools/convert_seabed.py -- [options]

Options:
    --in <path>        source .blend, .fbx, .glb or .obj. Defaults to $SEABED_SOURCE,
                       then to the first of SOURCE_CANDIDATES below that exists --
                       the .blend is not in the repo, so there is no single fixed
                       path that can be right on every machine
    --out <path>       output GLB   (default src/assets/Models/TectonicSeabed.glb)
    --object <name>    which mesh to convert. Required when the file holds more than
                       one, e.g. --object Mesher_LOD1.002
    --tris <n>         decimate target, in triangles (default 60000)
    --shape-from <how> where the swell comes from:
                         normals    (default) offset each vertex along its own normal
                                    by the mask weight times --amount
                         modifiers  use the sculpt's own Displace instead, evaluated
                                    with and without it. Keeps the texture detail and
                                    whatever CorrectiveSmooth is doing on top
    --shape-modifier <names>
                       comma-separated modifier names or types that create the swell,
                       muted for the rest pose (default Displace)
    --shape-gain <k>   multiply the modifier-derived swell by k (default 1.0). Use it
                       to push the effect past what the Displace strength gives
                       without going back into Blender; the component can only scale
                       it down from there
    --vgroup <name>    use this vertex group as the mask instead of the radial
                       falloff. Weight 1 expands fully, 0 not at all.
                       Requires a .blend source -- see below.
    --vcolor <name>    use this colour attribute as the mask instead. Greyscale:
                       white expands fully, black not at all. Works from an FBX.
    --inner <u>        radial mask: full expansion inside this radius  (default 0.10)
    --outer <u>        radial mask: no expansion beyond this radius    (default 0.42)
    --amount <u>       shape-key displacement along the normal at mask=1
                       (default 0.06, i.e. 6 mm of swell)
    --no-draco         skip mesh compression (bigger file, loads on anything)

Do not export the sculpt to glTF straight out of Blender
-------------------------------------------------------
With a Displace modifier on the stack, exporting applies it, and the swell is baked
into the mesh permanently -- the seabed ships fully expanded and nothing can bring it
back down. What the runtime needs is the *difference* between the two states, as a
morph target. Save the .blend and run:

    ... -P tools/convert_seabed.py -- --in TectonicSeabed.blend \
        --object Mesher_LOD1.002 --shape-from modifiers --vgroup VentSwell

You do not bake anything by hand
--------------------------------
Paint the mask in Blender and this script turns it into what the runtime needs. The
only thing to get right is which container it travels in:

    vertex group   ->  needs a .blend source. FBX only stores vertex groups as
                       armature skin weights, so a group on a plain sculpt is
                       dropped on export, silently. Save the .blend and point
                       --in at it.
    colour attr    ->  survives FBX. Paint greyscale in Vertex Paint and use
                       --vcolor. Use this if the sculpt has to arrive as FBX.

Why a morph target and not a shader
-----------------------------------
Expansion along the normal is linear in its amount:

    p(t) = p + n * mask * A * t

so a single shape key baked at A, lerped by t, reproduces every intermediate
amount exactly. The runtime only has to write one float per frame into
`morphTargetInfluences`, which needs no material patching and survives whatever
the engine does to the material. The `_MASK` attribute is exported as well for
the cases a morph target genuinely cannot cover -- per-vertex noise, a travelling
pulse, expansion that varies over the surface as it grows.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Where the sculpt might be. The .blend is the source of truth but it lives outside
# the repo -- it is 68 MB, it is an authoring file, and the 1 MB GLB it produces is
# the only thing the runtime ever loads. So the repo cannot simply point at it; look
# in the places it is likely to be, in order, and say so plainly when it is nowhere.
SOURCE_CANDIDATES = [
    os.path.join(os.path.dirname(ROOT), 'Models', 'TectonicSeabed.blend'),
    os.path.join(os.path.dirname(os.path.dirname(ROOT)), 'Models', 'TectonicSeabed.blend'),
    os.path.join(ROOT, 'src', 'assets', 'Models', 'TectonicSeabed.blend'),
    os.path.join(ROOT, 'src', 'assets', 'Models', 'TectonicSeabed.fbx'),
]

DEFAULTS = {
    'in': '',
    'out': os.path.join(ROOT, 'src', 'assets', 'Models', 'TectonicSeabed.glb'),
    'tris': 60000,
    'object': '',
    'vgroup': '',
    'vcolor': '',
    'shape-from': 'normals',
    'shape-modifier': 'Displace',
    'shape-gain': 1.0,
    'inner': 0.10,
    'outer': 0.42,
    'amount': 0.06,
}

MASK_ATTR = '_mask'
# Scratch attribute, removed before export: carries the swell through decimation.
MOVE_ATTR = 'swell_offset'
SHAPE_KEY = 'Expand'
# The sculpt is authored at 100 mm across, which is one block unit by definition.
TARGET_WIDTH_UNITS = 1.0


def parse_args(argv):
    args = dict(DEFAULTS)
    args['draco'] = True
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--no-draco':
            args['draco'] = False
            i += 1
            continue
        key = a[2:] if a.startswith('--') else None
        if key is None or key not in DEFAULTS:
            raise SystemExit('unknown option ' + repr(a))
        value = argv[i + 1]
        if key == 'tris':
            args[key] = int(value)
        elif key in ('inner', 'outer', 'amount', 'shape-gain'):
            args[key] = float(value)
        else:
            args[key] = value
        i += 2
    return args


def resolve_source(given):
    """Find the sculpt, or explain where it was looked for."""
    if given:
        if not os.path.exists(given):
            raise SystemExit('no such file: ' + given)
        return given
    env = os.environ.get('SEABED_SOURCE')
    if env:
        if not os.path.exists(env):
            raise SystemExit('SEABED_SOURCE is set to a file that does not exist: ' + env)
        return env
    for candidate in SOURCE_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    raise SystemExit(
        'could not find the sculpt. Pass --in <path>, or set SEABED_SOURCE.\n'
        'Looked in:\n  ' + '\n  '.join(SOURCE_CANDIDATES) + '\n'
        'The .blend is deliberately not in the repo -- it is an authoring file, and '
        'the GLB it produces is the only thing the app loads.')


def load(path):
    """Open the source, whatever it is.

    .blend is the better input and the default answer if you want to author the
    expansion mask yourself, because **vertex groups do not survive an FBX export**.
    Blender only writes them when they are skin weights on an armature; export a
    sculpt with a group and no armature and the group is silently gone -- verified,
    not assumed. So `--vgroup` only means anything when the source is a .blend.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext == '.blend':
        bpy.ops.wm.open_mainfile(filepath=path)
    elif ext == '.fbx':
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext in ('.glb', '.gltf'):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.obj':
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise SystemExit('do not know how to open ' + repr(path))
    print('[convert] opened ' + path)


def pick_mesh(name):
    """Choose the object to convert.

    A working .blend has a camera, a light, a cube used as some modifier's target and
    four LODs of the sculpt in it. Guessing between those, or joining them all as an
    earlier version of this script did, produces nonsense quietly. So: name it, or be
    told what the choices are.
    """
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    if not meshes:
        raise SystemExit('no mesh in the source file')
    if name:
        ob = bpy.data.objects.get(name)
        if ob is None or ob.type != 'MESH':
            raise SystemExit('no mesh object named {!r}. Meshes in this file: {}'.format(
                name, [o.name for o in meshes]))
        return ob
    if len(meshes) > 1:
        raise SystemExit(
            'this file has {} mesh objects, so --object is required: {}'.format(
                len(meshes), [o.name for o in meshes]))
    return meshes[0]



def flatten_transform(ob):
    """Bake the object transform into the mesh.

    The FBX carries a 180-degree flip on X from whichever DCC wrote it. Applying it
    now means the exported GLB needs no compensating rotation in the scene, and the
    shape-key normals below are computed in the space the runtime will see.
    """
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def measure(ob):
    xs = [v.co.x for v in ob.data.vertices]
    ys = [v.co.y for v in ob.data.vertices]
    zs = [v.co.z for v in ob.data.vertices]
    return (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))


def unsplit_normals(ob):
    """Drop the sculpt's custom split normals and sharp edges, and weld.

    This is worth more than any other step here. glTF has no concept of a split
    normal: a vertex that carries two normals has to be written out twice. The raw
    sculpt marks nearly every edge sharp, so a 60k-triangle mesh was exporting as
    142k vertices -- more corners than triangles -- and every per-vertex buffer,
    including the morph target, paid for it. Smooth-shading the decimated mesh
    gives about 30k vertices and, at this triangle density, still reads as rock.
    """
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
    me = ob.data
    if 'sharp_edge' in me.attributes:
        me.attributes.remove(me.attributes['sharp_edge'])
    if 'sharp_face' in me.attributes:
        me.attributes.remove(me.attributes['sharp_face'])
    bpy.ops.object.shade_smooth()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=1e-5)
    bpy.ops.object.mode_set(mode='OBJECT')
    print('[convert] smoothed and welded -> {} verts'.format(len(ob.data.vertices)))


def decimate(ob, target_tris):
    ob.data.calc_loop_triangles()
    tris = len(ob.data.loop_triangles)
    if tris <= target_tris:
        print('[convert] {} tris already under target, no decimation'.format(tris))
        return
    mod = ob.modifiers.new('decimate', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = target_tris / tris
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = ob
    # The sculpt may already carry a modifier stack -- a Displace driving the swell,
    # a CorrectiveSmooth cleaning up after it. Decimation has to happen underneath
    # all of that, both so those modifiers run on the geometry that ships and so
    # applying this one does not silently ignore the ones above it.
    bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    ob.data.calc_loop_triangles()
    print('[convert] decimated {} -> {} tris'.format(tris, len(ob.data.loop_triangles)))


def normalise_scale(ob, offsets=None):
    """Scale so the footprint is exactly one block unit, and rest the base on Z=0.

    `offsets`, if given, is a displacement per vertex measured in the source file's
    units; it is scaled by the same factor in place so it stays the same displacement
    relative to the model.
    """
    (x0, x1), (y0, y1), (z0, z1) = measure(ob)
    width = max(x1 - x0, y1 - y0)
    s = TARGET_WIDTH_UNITS / width
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for v in ob.data.vertices:
        v.co = Vector(((v.co.x - cx) * s, (v.co.y - cy) * s, (v.co.z - z0) * s))
    if offsets is not None:
        for i in range(len(offsets)):
            offsets[i] = offsets[i] * s
    ob.data.update()
    (nx0, nx1), (ny0, ny1), (nz0, nz1) = measure(ob)
    print('[convert] scaled by {:.6f} -> footprint {:.4f} x {:.4f} units, '
          'height {:.4f} units, base at {:.4f}'.format(
              s, nx1 - nx0, ny1 - ny0, nz1 - nz0, nz0))
    return nz1 - nz0


def report_anchors(ob, offsets=None):
    """Print where the surface actually is, in block units.

    The sculpt is a seabed relief, not a cone -- there is no obvious summit to hang
    the vent off. `ventHeight` on the Volcanic Seabed component is read off these
    numbers, and they move every time the sculpt is re-exported, so print them rather
    than guess in the TypeScript.

    Both states are reported when there is a swell, because they are the numbers that
    bracket the problem: set the vent to the rest height and the jet is swallowed by
    the rock as it expands; set it to the expanded height and it floats at rest.
    """
    import math as _m
    print('[convert] surface heights, block units:')
    for radius in (0.08, 0.15, 0.30, 0.46):
        rest, full = [], []
        for i, v in enumerate(ob.data.vertices):
            if _m.hypot(v.co.x, v.co.y) > radius:
                continue
            rest.append(v.co.z)
            if offsets is not None:
                full.append(v.co.z + offsets[i].z)
        if not rest:
            continue
        line = '             within r={:.2f}u  rest peak {:.4f}  mean {:.4f}'.format(
            radius, max(rest), sum(rest) / len(rest))
        if full:
            line += '   expanded peak {:.4f}  mean {:.4f}'.format(
                max(full), sum(full) / len(full))
        print(line)
    if offsets is not None:
        print('             -> ventHeight wants to sit between the two peaks at '
              'r=0.08u; expandAtFullHeat trades one against the other')


def mask_from_colour(ob, name):
    """Read the mask out of a colour attribute.

    This is the route that works when the source has to stay an FBX: colour
    attributes *do* survive the round trip where vertex groups do not, so a mask
    painted in Vertex Paint arrives intact. It comes back on the CORNER domain as
    bytes, whatever it was when it left, so average the corners back onto their
    vertex and read the sRGB value -- the grey that was actually painted, rather
    than its linearised form.
    """
    me = ob.data
    layer = me.color_attributes.get(name)
    if layer is None:
        have = [c.name for c in me.color_attributes]
        raise SystemExit('no colour attribute {!r} in the source (have {})'.format(name, have))

    def grey(datum):
        c = getattr(datum, 'color_srgb', None) or datum.color
        return (c[0] + c[1] + c[2]) / 3.0

    if layer.domain == 'POINT':
        weights = [grey(layer.data[i]) for i in range(len(me.vertices))]
    else:
        total = [0.0] * len(me.vertices)
        count = [0] * len(me.vertices)
        for li, loop in enumerate(me.loops):
            total[loop.vertex_index] += grey(layer.data[li])
            count[loop.vertex_index] += 1
        weights = [total[i] / count[i] if count[i] else 0.0 for i in range(len(me.vertices))]

    weights = [0.0 if w < 0 else (1.0 if w > 1 else w) for w in weights]
    print('[convert] mask from colour attribute {!r} ({} domain), {} of {} verts weighted'.format(
        name, layer.domain, sum(1 for w in weights if w > 0), len(weights)))
    return weights


def evaluated_coords(ob):
    """Vertex positions with the modifier stack applied, in object space."""
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    obe = ob.evaluated_get(deps)
    me = obe.to_mesh()
    coords = [v.co.copy() for v in me.vertices]
    obe.to_mesh_clear()
    return coords


def offsets_from_modifiers(ob, names):
    """Take the swell straight out of the modifier stack.

    This is the honest way to do it once the sculpt has a real Displace on it. The
    offset along the normal that this script computes on its own is a smooth,
    featureless inflation; a Displace driven by a texture through a vertex group,
    with a CorrectiveSmooth on top holding the square edges, is a different and much
    better-looking shape, and there is no reason to approximate it when Blender will
    just hand it over.

    Evaluate the stack twice -- once with the swell modifiers muted, once with them
    live -- and the difference is the morph target. Everything else in the stack runs
    in both passes, so a CorrectiveSmooth above the Displace is accounted for rather
    than fought with. Nothing in the stack may change the vertex count, which is why
    decimation is applied to the base mesh first.

    Two things about this that were measured rather than assumed:

    - Muting the Displace really does give back the undeformed mesh. A
      CorrectiveSmooth set to Original Coords has nothing to correct once the
      deformation is gone, so the rest pose is the sculpt, not a smoothed sculpt.
    - The live evaluation is bit-identical to what the glTF exporter writes, because
      both come from the same whole-stack depsgraph evaluation. The morph therefore
      lands exactly on the shape in the viewport.

    Applying the modifiers one at a time in the UI does *not* give that shape --
    baking the Displace moves the Original Coords that the CorrectiveSmooth measures
    against, so the smoothing quietly stops happening. Let this function do it.
    """
    wanted = [n.strip() for n in names.split(',') if n.strip()]
    drivers = [m for m in ob.modifiers if m.name in wanted or m.type in
               [n.upper().replace(' ', '_') for n in wanted]]
    if not drivers:
        raise SystemExit(
            'no modifier matching {!r} on {!r} (stack is {}). --shape-from modifiers '
            'needs the modifier that creates the swell, by name or by type.'.format(
                names, ob.name, [(m.name, m.type) for m in ob.modifiers]))

    for m in drivers:
        tex = getattr(m, 'texture', None)
        if tex is not None and tex.type == 'IMAGE' and tex.image is None:
            print('[convert] WARNING: {} uses image texture {!r} with no image assigned. '
                  'Blender reads it as 0 everywhere, so the displacement is a uniform '
                  '(0 - mid_level) * strength along the normal with no detail in it.'
                  .format(m.name, tex.name))

    live = [m.show_viewport for m in drivers]
    for m in drivers:
        m.show_viewport = False
    basis = evaluated_coords(ob)
    for m, was in zip(drivers, live):
        m.show_viewport = was
    swollen = evaluated_coords(ob)

    if len(basis) != len(swollen) or len(basis) != len(ob.data.vertices):
        raise SystemExit(
            'the modifier stack changes the vertex count ({} base, {} rest, {} swollen), '
            'so it cannot become a morph target. Apply or remove whatever generates '
            'geometry -- Subdivision, Solidify, Remesh -- before converting.'.format(
                len(ob.data.vertices), len(basis), len(swollen)))

    offsets = [swollen[i] - basis[i] for i in range(len(basis))]
    moved = sum(1 for o in offsets if o.length > 1e-6)
    peak = max((o.length for o in offsets), default=0.0)
    print('[convert] shape from modifiers {}: {} of {} verts move, peak {:.4f} '
          '(source units)'.format([m.name for m in drivers], moved, len(offsets), peak))
    # The base mesh must be the *unswollen* one, or the model ships permanently
    # expanded and the morph adds a second swell on top of the first.
    for i, v in enumerate(ob.data.vertices):
        v.co = basis[i]
    ob.data.update()
    # Every modifier that was live has now been accounted for -- the ones that deform
    # are in `offsets`, and the ones that do not (a CorrectiveSmooth has nothing to
    # correct at rest) contribute nothing. Leaving any of them on the object would
    # mean the decimation below runs underneath a stack that is no longer wanted.
    for m in list(ob.modifiers):
        ob.modifiers.remove(m)
    return offsets


def carry_offsets(ob, offsets, matrix3):
    """Park the offsets on the mesh so decimation and welding carry them along.

    A per-vertex offset list goes stale the moment the vertex count changes, and both
    decimation and the weld below change it. A FLOAT_VECTOR point attribute does not:
    Blender interpolates it through the collapse the same way it does UVs, so the
    offsets come out the other side still attached to the right vertices. Verified
    exact on a test grid decimated 10:1.

    `matrix3` is the rotation-and-scale part of the transform that
    `flatten_transform` is about to bake into the vertex coordinates. Offsets are
    directions, so they take that part and not the translation.
    """
    if MOVE_ATTR in ob.data.attributes:
        ob.data.attributes.remove(ob.data.attributes[MOVE_ATTR])
    attr = ob.data.attributes.new(name=MOVE_ATTR, type='FLOAT_VECTOR', domain='POINT')
    flat = []
    for o in offsets:
        d = matrix3 @ o
        flat += [d.x, d.y, d.z]
    attr.data.foreach_set('vector', flat)
    ob.data.update()


def recover_offsets(ob):
    attr = ob.data.attributes.get(MOVE_ATTR)
    if attr is None:
        raise SystemExit('the swell offsets did not survive decimation')
    flat = [0.0] * (len(ob.data.vertices) * 3)
    attr.data.foreach_get('vector', flat)
    offsets = [Vector(flat[i * 3:i * 3 + 3]) for i in range(len(ob.data.vertices))]
    ob.data.attributes.remove(ob.data.attributes[MOVE_ATTR])
    return offsets


def build_mask(ob, args):
    """Return one weight per vertex, in vertex order, 0..1."""
    me = ob.data
    if args['vcolor']:
        return mask_from_colour(ob, args['vcolor'])
    name = args['vgroup']
    if name:
        group = ob.vertex_groups.get(name)
        if group is None:
            have = [g.name for g in ob.vertex_groups]
            raise SystemExit(
                'no vertex group {!r} in the source (have {}).\n'
                'If the source is an FBX, that is expected rather than a mistake: FBX '
                'only carries vertex groups as armature skin weights, so a group on a '
                'plain sculpt is dropped on export. Point --in at the .blend instead, '
                'or paint the mask as a colour attribute and use --vcolor.'.format(name, have))
        weights = []
        for v in me.vertices:
            w = 0.0
            for g in v.groups:
                if g.group == group.index:
                    w = g.weight
                    break
            weights.append(w)
        print('[convert] mask from vertex group {!r}, {} of {} verts weighted'.format(
            name, sum(1 for w in weights if w > 0), len(weights)))
        return weights

    # No vertex group in the sculpt, so stand one in: a radial falloff around the
    # vent. Smoothstep rather than linear so the swell has no visible edge.
    inner, outer = args['inner'], args['outer']
    weights = []
    for v in me.vertices:
        r = math.hypot(v.co.x, v.co.y)
        t = (outer - r) / (outer - inner)
        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
        weights.append(t * t * (3 - 2 * t))
    print('[convert] mask from radial falloff, full inside {}u, zero beyond {}u'.format(
        inner, outer))
    return weights


def store_mask_attribute(ob, weights):
    me = ob.data
    if MASK_ATTR in me.attributes:
        me.attributes.remove(me.attributes[MASK_ATTR])
    attr = me.attributes.new(name=MASK_ATTR, type='FLOAT', domain='POINT')
    attr.data.foreach_set('value', weights)
    me.update()


def add_shape_key_from_offsets(ob, offsets):
    """Bake an already-computed per-vertex offset as the Expand shape key."""
    me = ob.data
    if me.shape_keys:
        ob.shape_key_clear()
    basis = ob.shape_key_add(name='Basis', from_mix=False)
    expand = ob.shape_key_add(name=SHAPE_KEY, from_mix=False)
    moved = 0
    peak = 0.0
    for i in range(len(me.vertices)):
        d = offsets[i]
        if d.length <= 1e-9:
            continue
        expand.data[i].co = basis.data[i].co + d
        moved += 1
        peak = max(peak, d.length)
    expand.value = 0.0
    print('[convert] shape key {!r}: {} verts offset, peak {:.4f} block units'.format(
        SHAPE_KEY, moved, peak))


def add_expand_shape_key(ob, weights, amount):
    """Bake `position += normal * mask * amount` as a shape key.

    Vertex normals, not face normals: offsetting each face along its own normal
    tears the surface apart at every edge, which is not what "expand the volume"
    means. The vertex normal is the averaged face normal, so the surface inflates
    and stays closed.
    """
    me = ob.data
    if me.shape_keys:
        ob.shape_key_clear()
    basis = ob.shape_key_add(name='Basis', from_mix=False)
    expand = ob.shape_key_add(name=SHAPE_KEY, from_mix=False)
    moved = 0
    for i, v in enumerate(me.vertices):
        w = weights[i]
        if w <= 0:
            continue
        expand.data[i].co = basis.data[i].co + v.normal * (w * amount)
        moved += 1
    expand.value = 0.0
    print('[convert] shape key {!r}: {} verts offset, max {}u along the vertex normal'.format(
        SHAPE_KEY, moved, amount))


def add_material(ob):
    """The sculpt arrives with no material at all; without one the exporter writes a
    primitive with no material and three.js falls back to flat white. A plain
    Principled BSDF gives the runtime something sane to start from, and something
    `ecs.Material` can override if the scene wants different rock."""
    mat = bpy.data.materials.new('SeabedRock')
    if mat.node_tree is None:          # `use_nodes` is on its way out in Blender 6
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (0.16, 0.15, 0.17, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.92
    bsdf.inputs['Metallic'].default_value = 0.05
    ob.data.materials.clear()
    ob.data.materials.append(mat)


def export(ob, args):
    out = args['out']
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        use_selection=True,
        export_yup=True,              # Blender is Z-up, glTF and three.js are Y-up
        export_apply=False,           # would strip the shape key
        export_normals=True,
        export_morph=True,
        export_morph_normal=False,   # a 6 mm swell barely turns the normals; not worth 12 B/vert
        export_attributes=True,       # carries `_mask` through as glTF `_MASK`
        export_materials='EXPORT',
        export_draco_mesh_compression_enable=args['draco'],
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_generic_quantization=12,
    )
    print('[convert] wrote {} ({:.2f} MB)'.format(out, os.path.getsize(out) / 1e6))


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    args = parse_args(argv)

    load(resolve_source(args['in']))

    ob = pick_mesh(args['object'])
    print('[convert] converting {!r}'.format(ob.name))
    # Nothing else in the file is deleted, deliberately: a Displace can take its
    # coordinates from another object, a Shrinkwrap can target one, and removing the
    # scene around the sculpt would change the result without saying so. Only this
    # object is selected for export.

    use_modifiers = args['shape-from'] == 'modifiers'
    if not use_modifiers and args['shape-from'] != 'normals':
        raise SystemExit("--shape-from must be 'normals' or 'modifiers'")

    # The modifier swell is measured *first*, on the mesh exactly as authored, and
    # then carried down through the rest of the pipeline as a vertex attribute. It
    # cannot be measured later, because two of the steps below change the answer:
    #
    #   decimating first  -- a CorrectiveSmooth set to Original Coords loses its rest
    #                        reference when the vertex count changes (Blender says so:
    #                        "Original vertex count mismatch"), and the swell came out
    #                        25% short on the real sculpt.
    #   smoothing normals -- a Displace set to Direction: Normal displaces along the
    #                        vertex normals, so clearing the sculpt's split normals
    #                        first quietly changes which way every vertex moves.
    #
    # It is also measured before the object transform is applied, so the offsets get
    # rotated by hand rather than trusting an attribute to be transformed for us.
    modifier_offsets = None
    if use_modifiers:
        modifier_offsets = offsets_from_modifiers(ob, args['shape-modifier'])
        gain = args['shape-gain']
        if gain != 1.0:
            modifier_offsets = [o * gain for o in modifier_offsets]
            print('[convert] shape gain x{}'.format(gain))
        carry_offsets(ob, modifier_offsets, ob.matrix_world.to_3x3())

    flatten_transform(ob)
    decimate(ob, args['tris'])
    unsplit_normals(ob)

    if use_modifiers:
        modifier_offsets = recover_offsets(ob)

    height = normalise_scale(ob, modifier_offsets)
    report_anchors(ob, modifier_offsets)

    weights = build_mask(ob, args)
    store_mask_attribute(ob, weights)
    if modifier_offsets is not None:
        add_shape_key_from_offsets(ob, modifier_offsets)
    else:
        add_expand_shape_key(ob, weights, args['amount'])
    add_material(ob)
    export(ob, args)

    print('[convert] done. Model is 1.0 x 1.0 x {:.4f} block units, '
          'origin at the centre of its base.'.format(height))


main()
