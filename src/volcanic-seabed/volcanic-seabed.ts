import * as ecs from '@8thwall/ecs'

import {CHARGE, ERUPT, LEDS, SET_TEMPERATURE, STATE} from './events'
import {Swarm, createSwarm, updateSwarm} from './swarm'
import {Water, createWater, disposeWater, updateWater} from './water'
import {Formations, createFormations, seedMaterials, updateFormations} from './formations'
import {TerrainField, buildTerrainField, heightAt} from './terrain'

// Everything below is authored in "block units": 1 unit = the width of the printed
// image target = 100 mm. The resin block described in the project plan is
// 10 x 10 x 7 cm, so it occupies 1.0 x 0.7 x 1.0 units sitting on the target plane.
//
// The component is added to an entity that is already rotated so that local +Y
// points out of the printed target. See the Seabed Root object in the scene.
const BLOCK_W = 1.0
const BLOCK_H = 0.7

// The sculpt. `tools/convert_seabed.py` turns TectonicSeabed.fbx into this GLB —
// the engine has no FBX loader, `ecs.GltfModel` takes a .glb/.gltf URL and nothing
// else. The converter scales the sculpt so its footprint is exactly one block unit
// with its base on Y=0, which is why it needs no transform here. It also bakes an
// "Expand" morph target: every vertex pushed along its own normal, weighted by a
// vertex mask. See EXPAND_KEY below.
const SEABED_MODEL = 'assets/Models/TectonicSeabed.glb'
const EXPAND_KEY = 'Expand'

// Greybox fallback, kept for `useModel: false`: a stack of cylinders, large to small.
const SEABED_TOP = 0.05
const TERRACES = 8
const TERRACE_H = 0.075
const SUMMIT_Y = SEABED_TOP + TERRACES * TERRACE_H
const BASE_R = 0.38
const SUMMIT_R = 0.085

const TEMP_MIN_C = 400
const TEMP_MAX_C = 1200

const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Quaternion for a rotation of `deg` degrees about a single axis. */
const axisQuat = (axis: 'x' | 'y' | 'z', deg: number) => {
  const h = (deg * Math.PI) / 360
  const s = Math.sin(h)
  return {
    x: axis === 'x' ? s : 0,
    y: axis === 'y' ? s : 0,
    z: axis === 'z' ? s : 0,
    w: Math.cos(h),
  }
}

const setRotation = (world, eid: ecs.Eid, axis: 'x' | 'y' | 'z', deg: number) => {
  const q = axisQuat(axis, deg)
  world.setQuaternion(eid, q.x, q.y, q.z, q.w)
}

/**
 * Magma colour ramp. Dull red at rest, white-yellow at full heat — the same range a
 * child is asked to reason about when they move the temperature slider.
 */
const magmaColour = (t: number) => {
  if (t < 0.5) {
    const k = t / 0.5
    return {r: mix(122, 255, k), g: mix(32, 112, k), b: mix(14, 20, k)}
  }
  const k = (t - 0.5) / 0.5
  return {r: 255, g: mix(112, 238, k), b: mix(20, 172, k)}
}

interface Seated {
  eid: ecs.Eid
  x: number
  z: number
}

interface Built {
  rock: ecs.Eid[]        // terraces, seabed, boulders — lit rock material
  /**
   * Lava seams and LED stand-ins, each carrying the plan position it was built at.
   *
   * The position is stored rather than read back off the Object3D because the runtime
   * keeps its transforms in the ECS store and composes `object.matrix` from them
   * directly -- `object.position` stays at the origin no matter where an entity is,
   * which is a quiet way to move everything to the centre of the block.
   */
  glow: Seated[]
  leds: Seated[]
  volume: ecs.Eid[]      // wireframe of the physical block
  pool: ecs.Eid
  swarms: Swarm[]
  /**
   * Where the vent is, in the component's local space. X and Z come from the schema;
   * Y is re-read from the sculpt every frame, because the surface under the vent
   * rises by most of its own height as the plate heats.
   */
  ventX: number
  ventZ: number
  ventY: number
  /**
   * The sampled sculpt. Null in greybox mode and until the GLB arrives; everything
   * that reads it has to cope with that.
   */
  field: TerrainField | null
  formations: Formations | null
  seated: boolean        // have the seams and LEDs been dropped onto the real surface yet
  /**
   * The three.js meshes inside the loaded GLB that carry the Expand morph target,
   * and the index of that target. Populated asynchronously — the model is still
   * downloading when `add` returns — so everything that touches it has to cope with
   * it being empty for the first second or two.
   */
  expand: {meshes: any[], index: number}
  /**
   * The water column. Null until it is built, which may be a frame or two after the
   * component is added — it hangs a raw three.js mesh off the entity's Object3D, and
   * that object does not always exist yet inside `add`.
   */
  water: Water | null
  waterWanted: boolean
  waterOptions: {level: number, width: number, amplitude: number,
    segments: number, depthSegments: number}
}

const built = new Map<ecs.Eid, Built>()
const drift = new Map<ecs.Eid, () => number>()

const child = (world, parent: ecs.Eid, x: number, y: number, z: number) => {
  const e = world.createEntity()
  world.setParent(e, parent)
  world.setPosition(e, x, y, z)
  return e
}

const rockMaterial = (world, eid: ecs.Eid, shade: number) => {
  ecs.Material.set(world, eid, {
    r: Math.round(shade * 1.0),
    g: Math.round(shade * 0.94),
    b: Math.round(shade * 1.06),
    roughness: 0.92,
    metalness: 0.05,
  })
}

const hotMaterial = (world, eid: ecs.Eid, r: number, g: number, b: number, opacity = 1) => {
  ecs.UnlitMaterial.set(world, eid, {r, g, b, opacity, forceTransparent: opacity < 1})
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Spawn the sculpt and latch on to its Expand morph target.
 *
 * `ecs.GltfModel.set` starts a download; the mesh does not exist yet when this
 * returns. `GLTF_MODEL_LOADED` fires on the entity once it does, and hands over the
 * raw three.js Group — which is the only way to reach `morphTargetInfluences`,
 * since the ECS attribute layer has no morph API.
 *
 * Why a morph target rather than a shader: expanding along the normal is linear in
 * its amount, `p(t) = p + n * mask * A * t`, so one shape key baked at A and lerped
 * by t reproduces every intermediate amount exactly. One float per frame, no
 * material patching, nothing to break when the engine swaps a material out. The
 * converter also exports the mask as a `_MASK` vertex attribute for the cases a
 * morph genuinely cannot cover — per-vertex noise, a travelling pulse — which need
 * `onBeforeCompile` on the material reached through this same event.
 */
const buildModel = (world, root: ecs.Eid, url: string, out: Built) => {
  const e = child(world, root, 0, 0, 0)
  ecs.GltfModel.set(world, e, {url})

  world.events.addListener(e, ecs.events.GLTF_MODEL_LOADED, (event) => {
    const group = (event.data as any).model
    const meshes: any[] = []
    let index = -1
    group.traverse((o: any) => {
      if (!o.isMesh || !o.morphTargetInfluences || !o.morphTargetDictionary) {
        return
      }
      const i = o.morphTargetDictionary[EXPAND_KEY]
      if (i === undefined) {
        return
      }
      index = i
      meshes.push(o)
    })
    if (!meshes.length) {
      console.warn(
        `[volcanic-seabed] ${url} has no "${EXPAND_KEY}" morph target — the seabed will`,
        'render but will not swell. Re-run tools/convert_seabed.py.'
      )
      return
    }
    out.expand = {meshes, index}
    // The same mesh is the only description of the terrain anyone has. Sample it now
    // rather than making the rest of the scene guess where the surface is.
    out.field = buildTerrainField(meshes[0])
    if (!out.field) {
      console.warn(
        '[volcanic-seabed] the model has no _mask attribute, so there is no terrain',
        'field: formations will not spawn and the vent will fall back to ventHeight.'
      )
    }
  })

  out.rock.push(e)
  return e
}

const buildSeabed = (world, root: ecs.Eid, rng: () => number, rockCount: number, out: Built) => {
  const floor = child(world, root, 0, SEABED_TOP / 2, 0)
  ecs.CylinderGeometry.set(world, floor, {radius: 0.52, height: SEABED_TOP})
  rockMaterial(world, floor, 44)
  out.rock.push(floor)

  // Boulders ringing the vent. Kept outside the cone footprint so they read as
  // seabed rather than as part of the volcano.
  for (let i = 0; i < rockCount; i++) {
    const a = rng() * Math.PI * 2
    const d = mix(BASE_R + 0.02, 0.5, rng())
    const r = mix(0.014, 0.042, rng() ** 1.6)
    const e = child(world, root, Math.cos(a) * d, SEABED_TOP + r * 0.6, Math.sin(a) * d)
    if (rng() < 0.5) {
      ecs.TetrahedronGeometry.set(world, e, {radius: r})
    } else {
      ecs.PolyhedronGeometry.set(world, e, {faces: rng() < 0.5 ? 8 : 12, radius: r})
    }
    setRotation(world, e, 'y', rng() * 360)
    rockMaterial(world, e, Math.round(mix(30, 74, rng())))
    out.rock.push(e)
  }
}

const buildCone = (world, root: ecs.Eid, rng: () => number, out: Built) => {
  // A stack of cylinders rather than a single cone: it gives the seamount the
  // terraced silhouette of a real basalt shield, and it leaves a flat summit for
  // the crater to sit in.
  for (let i = 0; i < TERRACES; i++) {
    const k = (TERRACES - 1 - i) / (TERRACES - 1)
    const radius = (SUMMIT_R + (BASE_R - SUMMIT_R) * k ** 1.15) * mix(0.94, 1.06, rng())
    const y = SEABED_TOP + i * TERRACE_H + TERRACE_H / 2
    const e = child(world, root, (rng() - 0.5) * 0.03, y, (rng() - 0.5) * 0.03)
    ecs.CylinderGeometry.set(world, e, {radius, height: TERRACE_H * 1.04})
    setRotation(world, e, 'y', rng() * 360)
    rockMaterial(world, e, Math.round(mix(34, 52, rng())))
    out.rock.push(e)
  }

  const rim = child(world, root, 0, SUMMIT_Y - 0.004, 0)
  ecs.TorusGeometry.set(world, rim, {radius: SUMMIT_R * 0.98, tubeRadius: 0.013})
  setRotation(world, rim, 'x', -90)
  rockMaterial(world, rim, 38)
  out.rock.push(rim)
}

/**
 * Everything that reads as heat: the pool sitting in the vent, the jet above it, and
 * the lava seams in the surrounding rock.
 *
 * Split out of `buildCone` because it has to serve both shapes, which are nothing
 * alike: the greybox is a cone whose profile the code chose, the sculpt is a seabed
 * relief with no summit at all. So the caller says where the vent is (`out.ventY`)
 * and how far out the seams reach, and hands over a `surfaceY` that answers "how
 * high is the rock this far from the centre" — for the cone that is its profile
 * inverted, for the sculpt an approximation, since raycasting the mesh would mean
 * waiting for it to download before any of this could be built.
 */
const buildVent = (
  world,
  root: ecs.Eid,
  rng: () => number,
  out: Built,
  seamRing: number,
  surfaceY: (d: number) => number
) => {
  const y = out.ventY

  for (let i = 0; i < 21; i++) {
    const a = rng() * Math.PI * 2
    const d = mix(SUMMIT_R * 1.2, seamRing, rng() ** 0.7)
    // Sunk a little into the rock rather than resting on it: a fissure is a crack
    // the light comes out of, not a bead sitting on the surface.
    const g = child(
      world, root,
      out.ventX + Math.cos(a) * d,
      surfaceY(d) - mix(0.004, 0.014, rng()),
      out.ventZ + Math.sin(a) * d
    )
    ecs.SphereGeometry.set(world, g, {radius: mix(0.008, 0.016, rng())})
    hotMaterial(world, g, 255, 96, 24, 0.85)
    out.glow.push({eid: g, x: out.ventX + Math.cos(a) * d, z: out.ventZ + Math.sin(a) * d})
  }

  out.pool = child(world, root, out.ventX, y + 0.012, out.ventZ)
  ecs.SphereGeometry.set(world, out.pool, {radius: SUMMIT_R * 0.78})
  hotMaterial(world, out.pool, 255, 120, 24)

  // There is deliberately no jet cone here any more. It belonged to the greybox
  // seamount, where it stood in a crater on a summit. On the sculpt there is no
  // summit for it to stand in, so it hung in the water attached to nothing -- and the
  // ash column already says "something is venting" without a solid object claiming
  // to be the plume.
}

const buildLeds = (world, root: ecs.Eid, out: Built, y: number) => {
  // Stand-ins for the micro-LEDs cast into the resin and lit through the tabletop
  // induction coil. In AR they are what the child sees respond to a tap; the same
  // signal is what the ESP32 bridge would act on.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4
    const e = child(world, root, Math.cos(a) * 0.46, y + 0.012, Math.sin(a) * 0.46)
    ecs.SphereGeometry.set(world, e, {radius: 0.018})
    hotMaterial(world, e, 90, 170, 210, 0.35)
    out.leds.push({eid: e, x: Math.cos(a) * 0.46, z: Math.sin(a) * 0.46})
  }
}

const buildVolume = (world, root: ecs.Eid, out: Built) => {
  // The proposal's "invisible bounding box matched to the physical dimensions".
  // Showing it is the clearest way to demonstrate that the digital layer is bound
  // to the real object rather than floating in front of it.
  const hw = BLOCK_W / 2
  const t = 0.004
  const edge = (x: number, y: number, z: number, w: number, h: number, d: number) => {
    const e = child(world, root, x, y, z)
    ecs.BoxGeometry.set(world, e, {width: w, height: h, depth: d})
    hotMaterial(world, e, 128, 214, 232, 0.22)
    out.volume.push(e)
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      edge(sx * hw, BLOCK_H / 2, sz * hw, t, BLOCK_H, t)                 // uprights
    }
  }
  for (const y of [0, BLOCK_H]) {
    for (const s of [-1, 1]) {
      edge(s * hw, y, 0, t, t, BLOCK_W)                                   // along Z
      edge(0, y, s * hw, BLOCK_W, t, t)                                   // along X
    }
  }
}

const buildParticles = (world, root: ecs.Eid, out: Built, rng: () => number, floorY: number) => {
  // Read through `out` inside the spawn closures rather than capturing the values
  // here: the vent moves vertically as the plate swells, and the column has to move
  // with it or it detaches from the rock it is supposed to be coming out of.
  const fade = (age: number, inTime = 0.15, outTime = 0.4) =>
    Math.min(1, age / inTime) * Math.min(1, (1 - age) / outTime)

  // Ash column. Buoyant in water, so it keeps climbing and spreads as it cools.
  out.swarms.push(createSwarm(world, root, {
    count: 44,
    radius: 0.034,
    shape: 'chunk',
    density: heat => 0.25 + 0.75 * heat,
    accel: [0, 0.05, 0],
    drag: 0.55,
    sway: 0.03,
    spawn: (r, heat) => {
      const a = r() * Math.PI * 2
      const d = r() * 0.045
      return {
        p: [out.ventX + Math.cos(a) * d, out.ventY + 0.03, out.ventZ + Math.sin(a) * d],
        v: [(r() - 0.5) * 0.06, 0.13 + 0.16 * heat + r() * 0.05, (r() - 0.5) * 0.06],
        span: mix(2, 3.4, r()),
      }
    },
    growth: age => 0.6 + 1.8 * age,
    colour: (age, heat) => [
      Math.round(mix(202, 96, age)),
      Math.round(mix(190, 90, age)),
      Math.round(mix(178, 98, age)),
      fade(age) * (0.5 + 0.3 * heat),
    ],
  }, rng))

  // Embers thrown clear of the vent, arcing back onto the flanks.
  out.swarms.push(createSwarm(world, root, {
    count: 20,
    radius: 0.014,
    shape: 'chunk',
    density: heat => (heat < 0.12 ? 0 : 0.2 + 0.8 * heat),
    accel: [0, -0.42, 0],
    drag: 0.9,
    spawn: (r, heat) => {
      const a = r() * Math.PI * 2
      return {
        p: [out.ventX + Math.cos(a) * 0.02, out.ventY + 0.02, out.ventZ + Math.sin(a) * 0.02],
        v: [
          Math.cos(a) * (0.06 + 0.14 * r()),
          0.32 + 0.5 * heat + r() * 0.12,
          Math.sin(a) * (0.06 + 0.14 * r()),
        ],
        span: mix(1.3, 2.6, r()),
      }
    },
    growth: age => 1 - 0.45 * age,
    colour: (age) => [
      255,
      Math.round(mix(228, 60, age)),
      Math.round(mix(170, 12, age)),
      fade(age, 0.06, 0.5),
    ],
  }, rng))

  // Gas seeping out of the seabed all around the vent.
  out.swarms.push(createSwarm(world, root, {
    count: 14,
    radius: 0.012,
    shape: 'round',
    density: heat => 0.4 + 0.6 * heat,
    accel: [0, 0.03, 0],
    drag: 0.98,
    sway: 0.012,
    spawn: (r) => {
      const a = r() * Math.PI * 2
      const d = mix(0.18, 0.5, r())
      return {
        p: [Math.cos(a) * d, floorY + 0.01, Math.sin(a) * d],
        v: [0, 0.07 + r() * 0.05, 0],
        span: mix(3.5, 6.5, r()),
      }
    },
    growth: age => 0.7 + 0.5 * age,
    colour: age => [206, 236, 252, fade(age, 0.2, 0.35) * 0.6],
  }, rng))

  // Marine snow settling through the whole block: sells the water column even when
  // the vent is cold.
  out.swarms.push(createSwarm(world, root, {
    count: 18,
    radius: 0.006,
    shape: 'chunk',
    density: () => 1,
    accel: [0, -0.004, 0],
    drag: 0.99,
    sway: 0.02,
    spawn: (r) => ({
      p: [(r() - 0.5) * BLOCK_W, BLOCK_H * (0.5 + 0.5 * r()), (r() - 0.5) * BLOCK_W],
      v: [0, -0.012 - r() * 0.01, 0],
      span: mix(9, 16, r()),
    }),
    growth: () => 1,
    colour: age => [214, 232, 240, fade(age, 0.15, 0.3) * 0.45],
  }, rng))
}

/**
 * Drop the pieces that are meant to be lying on the seabed onto the seabed.
 *
 * They were placed against an estimate of the surface when the component was built,
 * because the sculpt had not downloaded yet. Once it has, the estimate can be thrown
 * away: each one keeps its plan position and takes its height from the rock.
 *
 * Sampled at rest, not at the current swell — these are fixed to the plate, so they
 * should be embedded in it when it is cold and swallowed by it as it rises. That is
 * the seam closing up, which is the correct thing for a seam to do.
 */
const seatOnTerrain = (world, b: Built, rng: () => number) => {
  if (!b.field) {
    return
  }
  const seat = (s: Seated, sink: number) => {
    world.setPosition(s.eid, s.x, heightAt(b.field, s.x, s.z, 0) - sink, s.z)
  }
  b.glow.forEach(g => seat(g, mix(0.004, 0.014, rng())))
  b.leds.forEach(l => seat(l, -0.012))
}

const formationOpts = (schema) => ({
  count: schema.formationCount,
  minSize: schema.formationMinSize,
  maxSize: schema.formationMaxSize,
  crawlSpeed: schema.formationCrawl,
  holdTime: schema.formationHold,
})

const influenceOf = (data, schema) =>
  clamp01(clamp01(data.temperature + data.burst * 0.55) * schema.expandAtFullHeat)

const seatRng = new Map<ecs.Eid, () => number>()
const rng0 = (eid: ecs.Eid) => {
  let r = seatRng.get(eid)
  if (!r) {
    r = mulberry32(Number(eid % 100000n) * 7 + 3)
    seatRng.set(eid, r)
  }
  return r
}

// ---------------------------------------------------------------------------
// Runtime response
// ---------------------------------------------------------------------------

ecs.registerComponent({
  name: 'Volcanic Seabed',
  schema: {
    imageTargetName: ecs.string,
    startTemperature: ecs.f32,
    useModel: ecs.boolean,
    modelUrl: ecs.string,
    ventX: ecs.f32,
    ventZ: ecs.f32,
    ventHeight: ecs.f32,
    ventLift: ecs.f32,
    expandAtFullHeat: ecs.f32,
    formationCount: ecs.ui32,
    formationMinSize: ecs.f32,
    formationMaxSize: ecs.f32,
    formationCrawl: ecs.f32,
    formationHold: ecs.f32,
    rockCount: ecs.ui32,
    seed: ecs.ui32,
    showVolume: ecs.boolean,
    hideUntilFound: ecs.boolean,
    showWater: ecs.boolean,
    waterLevel: ecs.f32,
    waveAmplitude: ecs.f32,
    waterSegments: ecs.ui32,
  },
  schemaDefaults: {
    imageTargetName: 'volcano-base',
    startTemperature: 0.35,
    useModel: true,
    // Spelled out rather than referring to SEABED_MODEL: Studio reads schemaDefaults
    // by parsing this file, not by running it, and it will only accept a string,
    // number or boolean literal here. An identifier fails to load the component with
    // "expected NumericLiteral, StringLiteral, or BooleanLiteral".
    modelUrl: 'assets/Models/TectonicSeabed.glb',
    // Where the vent sits in plan, in block units, origin at the centre of the
    // 100 x 100 mm footprint. This is the mask-weighted centroid of the VentSwell
    // group measured off the exported model — the middle of the hot band, not the
    // middle of the block. In millimetres from the corner it is (43.9, 64.0).
    ventX: -0.061,
    ventZ: 0.140,
    // Fallback height, used only in greybox mode or before the model has loaded.
    // With the sculpt in place the height is read from it every frame instead.
    ventHeight: 0.115,
    // How far above the sampled surface the pool floats. The surface under the vent
    // climbs from 0.024 to 0.111 as the plate heats, which is why this is an offset
    // and not an absolute.
    ventLift: 0.012,
    // How far the Expand morph is driven at full heat, 0..1 of the 6 mm the
    // converter baked in. 0 turns the swell off without re-exporting anything.
    expandAtFullHeat: 1.0,
    rockCount: 34,
    seed: 7,
    showVolume: true,
    hideUntilFound: true,
    showWater: true,
    // The waterline, in block units. The resin block is 0.7 tall, so this leaves a
    // little air above the surface rather than filling to the brim.
    waterLevel: 0.62,
    // Wave height at the crest, block units. 0.02 is 2 mm on a 100 mm block, which
    // is about as much as reads as water rather than as jelly.
    waveAmplitude: 0.02,
    // Grid resolution across the surface. 48 gives ~6k vertices for the whole volume,
    // which a phone shades without noticing; below about 32 the Voronoi cells start
    // to alias into triangles.
    waterSegments: 48,
    // Platonic solids crystallising out of the hot rock. They spawn where the mask is
    // strong, crawl down its gradient into colder rock, and set.
    formationCount: 26,
    formationMinSize: 0.012,
    formationMaxSize: 0.038,
    formationCrawl: 0.055,
    formationHold: 7,
  },
  data: {
    temperature: ecs.f32,
    target: ecs.f32,
    burst: ecs.f32,
    elapsed: ecs.f32,
    ledLevel: ecs.f32,
    tracked: ecs.boolean,
  },
  add: (world, component) => {
    const {eid, schema, data} = component
    const rng = mulberry32(schema.seed || 1)

    const useModel = schema.useModel
    const out: Built = {
      rock: [], glow: [], leds: [], volume: [],
      pool: 0n, swarms: [],
      ventX: useModel ? schema.ventX : 0,
      ventZ: useModel ? schema.ventZ : 0,
      ventY: useModel ? schema.ventHeight : SUMMIT_Y,
      field: null,
      formations: null,
      seated: false,
      expand: {meshes: [], index: -1},
      water: null,
      waterWanted: schema.showWater,
      waterOptions: {
        level: schema.waterLevel,
        width: BLOCK_W,
        amplitude: schema.waveAmplitude,
        segments: schema.waterSegments,
        depthSegments: 6,
      },
    }

    // The sculpt is the whole seamount and the whole seabed floor, so when it is in
    // use the greybox rock — floor disc, boulder field, terrace stack, crater rim —
    // is not built at all rather than being built and hidden. Everything else in
    // here is an effect rather than a stand-in for the sculpt, so it survives both
    // ways; it just has to be told how high the surface is.
    const floorY = useModel ? schema.ventHeight * 0.75 : SEABED_TOP
    if (useModel) {
      buildModel(world, eid, schema.modelUrl || SEABED_MODEL, out)
      // The sculpt is a relief, not a cone: away from the vent it stays roughly flat
      // at about three quarters of the vent height. Good enough to bed the seams and
      // the LEDs into, and it costs nothing.
      buildVent(world, eid, rng, out, 0.40, d => mix(out.ventY, floorY, clamp01(d / 0.40)))
    } else {
      buildSeabed(world, eid, rng, schema.rockCount, out)
      buildCone(world, eid, rng, out)
      // Invert the terrace profile so the seams land on the cone rather than beside it.
      buildVent(world, eid, rng, out, BASE_R, (d) => {
        const k = clamp01((d - SUMMIT_R) / (BASE_R - SUMMIT_R)) ** (1 / 1.15)
        return SUMMIT_Y - k * (SUMMIT_Y - SEABED_TOP)
      })
    }
    buildLeds(world, eid, out, floorY)
    buildParticles(world, eid, out, rng, floorY)
    if (schema.showVolume) {
      buildVolume(world, eid, out)
    }
    if (out.waterWanted) {
      out.water = createWater(world, eid, out.waterOptions)
    }

    built.set(eid, out)
    drift.set(eid, mulberry32(schema.seed * 977 + 13))

    data.temperature = schema.startTemperature
    data.target = schema.startTemperature
    data.burst = 0
    data.elapsed = 0
    data.ledLevel = 0
    data.tracked = !schema.hideUntilFound

    if (schema.hideUntilFound) {
      ecs.Hidden.set(world, eid, {})
    }
  },
  remove: (world, component) => {
    const b = built.get(component.eid)
    if (b?.water) {
      // A raw three.js mesh is not an entity, so nothing tears it down for us.
      disposeWater(b.water)
    }
    built.delete(component.eid)
    drift.delete(component.eid)
  },
  tick: (world, component) => {
    const {eid, data, schema} = component
    const b = built.get(eid)
    if (!b) {
      return
    }

    const dt = world.time.delta / 1000
    data.elapsed += dt

    // Ease toward the requested temperature so the slider feels like heating rock
    // rather than flipping a switch.
    data.temperature += (data.target - data.temperature) * Math.min(1, dt * 2.2)
    data.burst = Math.max(0, data.burst - dt * 0.3)

    const heat = clamp01(data.temperature + data.burst * 0.55)
    const pulse = 0.5 + 0.5 * Math.sin(data.elapsed * 2.6)
    const flicker = 0.85 + 0.15 * Math.sin(data.elapsed * 11.3)

    const c = magmaColour(heat)
    ecs.UnlitMaterial.mutate(world, b.pool, (m) => {
      m.r = Math.round(c.r)
      m.g = Math.round(c.g * (0.9 + 0.1 * pulse))
      m.b = Math.round(c.b)
    })

    // The pool breathes with the flicker instead of the jet cone that used to do it.
    const poolScale = 0.85 + 0.4 * heat * flicker
    world.setScale(b.pool, poolScale, poolScale * 0.75, poolScale)

    b.glow.forEach((g, i) => {
      const phase = 0.5 + 0.5 * Math.sin(data.elapsed * 1.8 + i)
      ecs.UnlitMaterial.mutate(world, g.eid, (m) => {
        m.r = Math.round(c.r)
        m.g = Math.round(c.g)
        m.b = Math.round(c.b)
        m.opacity = clamp01(0.15 + 0.85 * heat * (0.7 + 0.3 * phase))
      })
    })

    b.leds.forEach((led, i) => {
      const lit = data.ledLevel * (0.6 + 0.4 * Math.sin(data.elapsed * 6 + i * 1.1))
      ecs.UnlitMaterial.mutate(world, led.eid, (m) => {
        m.r = Math.round(mix(90, 255, clamp01(lit)))
        m.g = Math.round(mix(170, 246, clamp01(lit)))
        m.b = Math.round(mix(210, 255, clamp01(lit)))
        m.opacity = clamp01(0.3 + 0.7 * lit)
      })
    })

    // Once the sculpt has arrived and been sampled, everything that is supposed to
    // be resting on it gets put where it actually is. The seams and the LEDs only
    // need doing once; the vent needs doing every frame, because the rock under it
    // rises by most of its own height as the plate heats.
    if (b.field) {
      if (!b.seated) {
        b.seated = true
        seatOnTerrain(world, b, rng0(eid))
        if (schema.formationCount > 0) {
          b.formations = createFormations(world, eid, b.field, formationOpts(schema),
            mulberry32(schema.seed * 31 + 5))
          seedMaterials(world, b.formations)
        }
      }
      b.ventY = heightAt(b.field, b.ventX, b.ventZ, influenceOf(data, schema)) + schema.ventLift
      world.setPosition(b.pool, b.ventX, b.ventY + 0.012, b.ventZ)
    }

    // Volume expansion. `heat` already carries the eruption burst, so the sculpt
    // swells as the vent is charged and relaxes as it cools — the same single value
    // that drives every other response in here. The mesh list is empty until the GLB
    // finishes downloading, which is why this is a forEach over a possibly empty
    // array rather than a null check.
    const influence = influenceOf(data, schema)
    b.expand.meshes.forEach((m) => {
      m.morphTargetInfluences[b.expand.index] = influence
    })

    if (b.formations && b.field) {
      updateFormations(world, b.formations, dt, heat, influence,
        drift.get(eid), formationOpts(schema), magmaColour)
    }

    if (b.waterWanted) {
      if (!b.water) {
        b.water = createWater(world, eid, b.waterOptions)
      }
      if (b.water) {
        updateWater(b.water, data.elapsed, heat)
      }
    }

    const rng = drift.get(eid)
    b.swarms.forEach(s => updateSwarm(world, s, dt, heat, rng))

    world.events.dispatch(world.events.globalId, STATE, {
      temperature: data.temperature,
      celsius: Math.round(mix(TEMP_MIN_C, TEMP_MAX_C, heat)),
      erupting: data.burst > 0.05,
      tracked: data.tracked,
    })
  },
  stateMachine: ({world, eid, schemaAttribute, dataAttribute}) => {
    ecs.defineState('default')
      .initial()
      .listen(world.events.globalId, SET_TEMPERATURE, (e) => {
        dataAttribute.cursor(eid).target = clamp01((e.data as any).value)
      })
      .listen(world.events.globalId, ERUPT, (e) => {
        const power = (e.data as any)?.power ?? 1
        dataAttribute.cursor(eid).burst = clamp01(power)
      })
      .listen(world.events.globalId, LEDS, (e) => {
        const {on, intensity} = e.data as any
        dataAttribute.cursor(eid).ledLevel = on ? clamp01(intensity ?? 1) : 0
      })
      .listen(world.events.globalId, CHARGE, (e) => {
        // Bleed a little heat in as the child charges, so the block reacts before
        // the eruption actually fires.
        const level = clamp01((e.data as any).level)
        const cursor = dataAttribute.cursor(eid)
        cursor.ledLevel = Math.max(cursor.ledLevel, level * 0.7)
      })
      .listen(world.events.globalId, 'reality.imagefound', (e) => {
        if ((e.data as any).name !== schemaAttribute.get(eid).imageTargetName) {
          return
        }
        dataAttribute.cursor(eid).tracked = true
        ecs.Hidden.remove(world, eid)
      })
      .listen(world.events.globalId, 'reality.imagelost', (e) => {
        if ((e.data as any).name !== schemaAttribute.get(eid).imageTargetName) {
          return
        }
        if (!schemaAttribute.get(eid).hideUntilFound) {
          return
        }
        dataAttribute.cursor(eid).tracked = false
        ecs.Hidden.set(world, eid, {})
      })
  },
})
