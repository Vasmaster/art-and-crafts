import * as ecs from '@8thwall/ecs'

// A small, explicit particle system.
//
// ecs.ParticleEmitter exists and is cheaper, but its forces are applied in world
// space with an implicit gravity, which fights an image-target scene where "up" is
// the target normal rather than world +Y — ash ended up several metres below the
// table. Everything here runs in the local frame of the entity it is attached to,
// so it behaves the same however the block is held.
//
// Pools are fixed size and allocated once; particles are parked at zero scale
// instead of being created and destroyed.

export interface SwarmSpec {
  count: number
  /** Base radius of one particle, in block units. */
  radius: number
  /**
   * `sprite` is a textured quad turned to face the camera; `chunk` and `round` are
   * solid low-poly geometry.
   *
   * Ash used to be a `chunk`. At the size a particle is drawn on a phone a
   * tetrahedron is four flat facets and a hard silhouette — it reads as debris
   * however it is coloured, and it was the last part of the scene that still looked
   * like placeholder geometry. A sprite reads as smoke at any size and costs two
   * triangles instead of four.
   */
  shape: 'chunk' | 'round' | 'sprite'
  /** Sprite only: URL of the texture, white with the shape in its alpha. */
  texture?: string
  /**
   * Sprite only: give each particle a fixed random roll about the view axis. Without
   * it every puff in the column is the same picture at the same angle, and the eye
   * picks the repetition out immediately.
   */
  roll?: boolean
  /** Fraction of the pool that is allowed to live, given the current heat. */
  density: (heat: number) => number
  spawn: (rng: () => number, heat: number) => {
    p: [number, number, number]
    v: [number, number, number]
    span: number
  }
  /** Constant acceleration in local space; +Y is up out of the printed target. */
  accel: [number, number, number]
  /** Velocity retained per second, 1 = frictionless. */
  drag: number
  /** Size multiplier over the particle's life. */
  growth: (age: number) => number
  colour: (age: number, heat: number) => [number, number, number, number]
  /** Sideways wobble amplitude, for things drifting through water. */
  sway?: number
}

export interface Swarm {
  spec: SwarmSpec
  /** Kept so the billboard rotation can be worked out in this entity's space. */
  parent: ecs.Eid
  eids: ecs.Eid[]
  p: number[]      // flat xyz
  v: number[]      // flat xyz
  age: number[]
  span: number[]
  phase: number[]
}

export const createSwarm = (
  world,
  parent: ecs.Eid,
  spec: SwarmSpec,
  rng: () => number
): Swarm => {
  const swarm: Swarm = {
    spec, parent, eids: [], p: [], v: [], age: [], span: [], phase: [],
  }

  for (let i = 0; i < spec.count; i++) {
    const e = world.createEntity()
    world.setParent(e, parent)
    world.setPosition(e, 0, 0, 0)
    world.setScale(e, 0, 0, 0)
    if (spec.shape === 'sprite') {
      ecs.PlaneGeometry.set(world, e, {width: spec.radius * 2, height: spec.radius * 2})
    } else if (spec.shape === 'round') {
      ecs.SphereGeometry.set(world, e, {radius: spec.radius})
    } else {
      ecs.TetrahedronGeometry.set(world, e, {radius: spec.radius})
    }
    ecs.UnlitMaterial.set(world, e, {
      r: 255,
      g: 255,
      b: 255,
      opacity: 0,
      forceTransparent: true,
      ...(spec.shape === 'sprite' ? {
        textureSrc: spec.texture,
        // A cloud of sprites has no meaningful front-to-back order, and writing depth
        // would make each one punch a hole in the ones behind it.
        depthWrite: false,
        side: 'double',
      } : {}),
    })
    swarm.eids.push(e)
    swarm.p.push(0, 0, 0)
    swarm.v.push(0, 0, 0)
    // Stagger the initial ages so the pool does not pulse in unison.
    swarm.age.push(rng() * 4)
    swarm.span.push(0)
    swarm.phase.push(rng() * Math.PI * 2)
  }

  return swarm
}

const respawn = (swarm: Swarm, i: number, rng: () => number, heat: number) => {
  const {p, v, span} = swarm.spec.spawn(rng, heat)
  swarm.p[i * 3] = p[0]
  swarm.p[i * 3 + 1] = p[1]
  swarm.p[i * 3 + 2] = p[2]
  swarm.v[i * 3] = v[0]
  swarm.v[i * 3 + 1] = v[1]
  swarm.v[i * 3 + 2] = v[2]
  swarm.age[i] = 0
  swarm.span[i] = span
}

// Scratch objects, allocated once. A particle update runs a few hundred times a
// frame and three.js maths types are not free to construct.
let scratch: any = null

const ensureScratch = () => {
  const THREE = (window as any).THREE
  if (!THREE) {
    return null
  }
  if (!scratch) {
    scratch = {
      qCam: new THREE.Quaternion(),
      qHost: new THREE.Quaternion(),
      qRoll: new THREE.Quaternion(),
      qOut: new THREE.Quaternion(),
      forward: new THREE.Vector3(0, 0, 1),
    }
  }
  return scratch
}

/**
 * Rotation that turns a particle to face the camera, expressed in the parent's space.
 *
 * Every particle in a swarm shares a parent, so this is the same quaternion for all
 * of them and is worked out once per swarm per frame rather than once per particle.
 *
 * Read from `matrixWorld` rather than asking for the world quaternion: the runtime
 * keeps its transforms in its own store and composes matrices from them, so the
 * decomposed `quaternion` property of an Object3D is not reliable. One frame of lag
 * on a billboard is invisible.
 */
const billboardRotation = (world, parent: ecs.Eid) => {
  const sc = ensureScratch()
  const cam = world.three?.activeCamera
  const host = world.three?.entityToObject?.get(parent)
  if (!sc || !cam || !host) {
    return null
  }
  sc.qCam.setFromRotationMatrix(cam.matrixWorld)
  sc.qHost.setFromRotationMatrix(host.matrixWorld)
  return sc.qHost.invert().multiply(sc.qCam)
}

export const updateSwarm = (
  world,
  swarm: Swarm,
  dt: number,
  heat: number,
  rng: () => number
) => {
  const {spec} = swarm
  const bill = spec.shape === 'sprite' ? billboardRotation(world, swarm.parent) : null
  const live = Math.round(spec.count * spec.density(heat))
  const [ax, ay, az] = spec.accel
  const keep = spec.drag ** dt

  for (let i = 0; i < spec.count; i++) {
    const eid = swarm.eids[i]

    if (i >= live) {
      if (swarm.span[i] !== 0) {
        swarm.span[i] = 0
        world.setScale(eid, 0, 0, 0)
      }
      continue
    }

    swarm.age[i] += dt
    if (swarm.span[i] === 0 || swarm.age[i] >= swarm.span[i]) {
      respawn(swarm, i, rng, heat)
    }

    const j = i * 3
    swarm.v[j] = swarm.v[j] * keep + ax * dt
    swarm.v[j + 1] = swarm.v[j + 1] * keep + ay * dt
    swarm.v[j + 2] = swarm.v[j + 2] * keep + az * dt
    swarm.p[j] += swarm.v[j] * dt
    swarm.p[j + 1] += swarm.v[j + 1] * dt
    swarm.p[j + 2] += swarm.v[j + 2] * dt

    const age = swarm.age[i] / swarm.span[i]
    let x = swarm.p[j]
    let z = swarm.p[j + 2]
    if (spec.sway) {
      const t = swarm.age[i] * 1.4 + swarm.phase[i]
      x += Math.sin(t) * spec.sway
      z += Math.cos(t * 0.83) * spec.sway
    }

    world.setPosition(eid, x, swarm.p[j + 1], z)
    const s = spec.growth(age)
    world.setScale(eid, s, s, s)

    if (bill) {
      if (spec.roll) {
        scratch.qRoll.setFromAxisAngle(scratch.forward, swarm.phase[i])
        scratch.qOut.copy(bill).multiply(scratch.qRoll)
        world.setQuaternion(eid, scratch.qOut.x, scratch.qOut.y, scratch.qOut.z, scratch.qOut.w)
      } else {
        world.setQuaternion(eid, bill.x, bill.y, bill.z, bill.w)
      }
    }

    const [r, g, b, o] = spec.colour(age, heat)
    ecs.UnlitMaterial.mutate(world, eid, (m) => {
      m.r = r
      m.g = g
      m.b = b
      m.opacity = o
    })
  }
}
