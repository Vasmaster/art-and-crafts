/**
 * Mineral formations: the five Platonic solids, crystallising out of the hot rock.
 *
 * The story they tell is the one the vertex mask already encodes. Where the mask is
 * strongest the tectonic plate is hottest, so that is where new material comes up.
 * Each solid is born there molten and glowing, creeps outward down the mask gradient
 * into colder rock, cools as it goes, and sets — dark, still, and faceted. Then it
 * fades and another comes up behind it. A child watching the temperature slider sees
 * the whole cycle speed up and slow down.
 *
 * They stay on the surface because the surface is sampled rather than assumed: see
 * `terrain.ts`. That matters more than it sounds, because the sculpt swells by up to
 * 140 mm as it heats, so anything sitting on it has to ride that or it buries itself.
 *
 * Only four of the five come from `ecs.PolyhedronGeometry` — `faces: 6` builds
 * nothing at all, so the cube is a `BoxGeometry` with equal sides. Measured, not
 * assumed: 4 -> 12 vertices, 8 -> 24, 12 -> 60, 20 -> 108, 6 -> 0.
 */

import * as ecs from '@8thwall/ecs'

import {TerrainField, heightAt, maskAt, maskGradient, sampleHotPoint} from './terrain'

const mix = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export type Solid = 'tetrahedron' | 'cube' | 'octahedron' | 'icosahedron' | 'dodecahedron'

const SOLIDS: Solid[] = [
  'tetrahedron', 'cube', 'octahedron', 'icosahedron', 'dodecahedron',
]

interface Item {
  eid: ecs.Eid
  solid: Solid
  x: number
  z: number
  size: number          // circumradius in block units
  /** 1 while molten, 0 once it has set. Drives colour, motion and emission. */
  temp: number
  /** Seconds it has spent frozen; past `holdTime` it fades and is reborn. */
  held: number
  spinAxis: number
  spin: number
  angle: number
}

export interface Formations {
  items: Item[]
  field: TerrainField
}

export interface FormationOptions {
  count: number
  minSize: number
  maxSize: number
  /** Block units per second at full heat. */
  crawlSpeed: number
  /** How long a set formation stays before being recycled, in seconds. */
  holdTime: number
}

/** Quaternion about an axis in the XZ plane, tilted, so they tumble rather than spin flat. */
const tumble = (world, eid: ecs.Eid, axis: number, angle: number) => {
  const ax = Math.cos(axis)
  const az = Math.sin(axis)
  const ay = 0.6
  const len = Math.hypot(ax, ay, az)
  const h = angle / 2
  const s = Math.sin(h) / len
  world.setQuaternion(eid, ax * s, ay * s, az * s, Math.cos(h))
}

const applyGeometry = (world, eid: ecs.Eid, solid: Solid, size: number) => {
  switch (solid) {
    case 'tetrahedron':
      ecs.TetrahedronGeometry.set(world, eid, {radius: size})
      break
    case 'cube': {
      // No polyhedron form: `faces: 6` returns an empty geometry. A box whose sides
      // are the cube inscribed in the same sphere keeps it the same visual weight as
      // the other four.
      const edge = size * 1.1547
      ecs.BoxGeometry.set(world, eid, {width: edge, height: edge, depth: edge})
      break
    }
    case 'octahedron':
      ecs.PolyhedronGeometry.set(world, eid, {faces: 8, radius: size})
      break
    case 'icosahedron':
      ecs.PolyhedronGeometry.set(world, eid, {faces: 12, radius: size})
      break
    default:
      ecs.PolyhedronGeometry.set(world, eid, {faces: 20, radius: size})
  }
}

const reseed = (item: Item, f: TerrainField, rng: () => number, o: FormationOptions) => {
  const [x, z] = sampleHotPoint(f, rng)
  item.x = x
  item.z = z
  item.temp = 1
  item.held = 0
  item.angle = rng() * Math.PI * 2
  item.spinAxis = rng() * Math.PI * 2
  item.spin = (rng() - 0.5) * 1.6
}

export const createFormations = (
  world,
  root: ecs.Eid,
  field: TerrainField,
  o: FormationOptions,
  rng: () => number
): Formations => {
  const items: Item[] = []
  for (let i = 0; i < o.count; i++) {
    const eid = world.createEntity()
    world.setParent(eid, root)

    const solid = SOLIDS[Math.floor(rng() * SOLIDS.length)]
    // Uniform in size rather than in volume: a uniform draw on the radius gives a
    // field dominated visually by the few largest, which reads as debris. Biasing
    // small keeps it looking like crystals rather than boulders.
    const size = mix(o.minSize, o.maxSize, rng() ** 1.7)
    applyGeometry(world, eid, solid, size)

    const item: Item = {
      eid, solid, x: 0, z: 0, size,
      temp: 1, held: 0, spinAxis: 0, spin: 0, angle: 0,
    }
    reseed(item, field, rng, o)
    // Stagger the starting temperatures so they do not all set on the same frame.
    item.temp = rng()
    items.push(item)
  }
  return {items, field}
}

/**
 * Advance every formation.
 *
 * `colour` is the scene's magma ramp, passed in rather than imported so this module
 * does not have to depend on the component that owns it.
 */
export const updateFormations = (
  world,
  f: Formations,
  dt: number,
  heat: number,
  influence: number,
  rng: () => number,
  o: FormationOptions,
  colour: (t: number) => {r: number, g: number, b: number}
) => {
  for (const item of f.items) {
    const hot = maskAt(f.field, item.x, item.z)

    if (item.temp > 0.02) {
      // Downhill in hotness: out of the ridge and towards the cold rock. The mask is
      // flat in places, so a little jitter keeps them from stalling in a plateau and
      // stops the whole field taking the same path.
      const [gx, gz] = maskGradient(f.field, item.x, item.z)
      const speed = o.crawlSpeed * heat * item.temp
      item.x += (-gx + (rng() - 0.5) * 0.5) * speed * dt
      item.z += (-gz + (rng() - 0.5) * 0.5) * speed * dt
      item.x = Math.max(-0.47, Math.min(0.47, item.x))
      item.z = Math.max(-0.47, Math.min(0.47, item.z))

      // Cooling: fast out on the cold rock, slow while it is still over the ridge,
      // and slower still when the whole plate is hot. This is what makes the slider
      // change how far they get before they set.
      const shelter = mix(1.0, 0.25, hot) * mix(1.0, 0.45, heat)
      item.temp = Math.max(0, item.temp - dt * 0.16 * shelter)

      item.angle += item.spin * dt * item.temp
    } else {
      item.held += dt
      if (item.held > o.holdTime) {
        reseed(item, f.field, rng, o)
      }
    }

    // Sit on the surface, riding the swell. Slightly less than half the circumradius
    // above it, so they read as growing out of the rock rather than resting on it.
    const y = heightAt(f.field, item.x, item.z, influence) + item.size * 0.42
    world.setPosition(item.eid, item.x, y, item.z)
    tumble(world, item.eid, item.spinAxis, item.angle)

    // Fade the last of the hold out, so recycling does not pop.
    const fade = item.temp > 0.02
      ? 1
      : clamp01((o.holdTime - item.held) / Math.max(o.holdTime * 0.25, 0.001))
    world.setScale(item.eid, fade, fade, fade)

    // Molten glows, set rock does not. Same ramp as the vent pool, so the whole
    // scene agrees about what a given temperature looks like.
    const c = colour(clamp01(item.temp * mix(0.55, 1, heat)))
    ecs.Material.mutate(world, item.eid, (m) => {
      m.r = Math.round(mix(38, c.r, item.temp))
      m.g = Math.round(mix(36, c.g, item.temp))
      m.b = Math.round(mix(42, c.b, item.temp))
      m.emissiveR = Math.round(c.r)
      m.emissiveG = Math.round(c.g)
      m.emissiveB = Math.round(c.b)
      m.emissiveIntensity = item.temp * item.temp * (0.35 + 1.5 * heat)
    })
  }
}

export const seedMaterials = (world, f: Formations) => {
  for (const item of f.items) {
    ecs.Material.set(world, item.eid, {
      r: 38, g: 36, b: 42,
      roughness: 0.55,
      metalness: 0.15,
      emissiveR: 255, emissiveG: 120, emissiveB: 24,
      emissiveIntensity: 0,
    })
  }
}
