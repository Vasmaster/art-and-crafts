import * as ecs from '@8thwall/ecs'

import {CHARGE, ERUPT, LEDS} from './events'

// "Tectonic Charge": the child taps the volcano to build pressure. At full charge the
// vent erupts and the LEDs in the block light up.
//
// Research question 2 in the project plan asks whether appless WebAR can drive real
// embedded hardware. This component is the seam where that happens: it emits the same
// LEDS event whether or not any hardware is attached, and forwards it over a plain
// WebSocket when `websocketUrl` is set on the component in the editor. Leave the URL
// blank and the demo is screen-only, which is how it should run in a workshop where
// no coil is on the table.
//
// The ESP32 sketch only has to accept {"leds": true, "intensity": 0.0-1.0}.

// Three taps fire it, with enough headroom that a child tapping at their own pace
// still gets there before the pressure bleeds off.
const CHARGE_PER_TAP = 0.4
const DECAY_PER_SECOND = 0.18
const LIT_SECONDS = 6

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

const sockets = new Map<ecs.Eid, WebSocket>()

const connect = (eid: ecs.Eid, url: string) => {
  if (!url || sockets.has(eid)) {
    return
  }
  try {
    const socket = new WebSocket(url)
    socket.addEventListener('error', () => {
      console.warn(`[tectonic-charge] no hardware at ${url}; running screen-only`)
    })
    sockets.set(eid, socket)
  } catch (err) {
    console.warn('[tectonic-charge] could not open hardware socket', err)
  }
}

const send = (eid: ecs.Eid, payload: unknown) => {
  const socket = sockets.get(eid)
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

ecs.registerComponent({
  name: 'Tectonic Charge',
  schema: {
    // Tapping this entity charges the vent. Point it at the volcano collider, or at a
    // HUD button if you would rather drive it from the on-screen controls.
    tapTarget: ecs.eid,
    websocketUrl: ecs.string,
  },
  schemaDefaults: {
    websocketUrl: '',
  },
  data: {
    level: ecs.f32,
    litFor: ecs.f32,
  },
  add: (world, component) => {
    component.data.level = 0
    component.data.litFor = 0
    connect(component.eid, component.schema.websocketUrl)
  },
  remove: (world, component) => {
    sockets.get(component.eid)?.close()
    sockets.delete(component.eid)
  },
  tick: (world, component) => {
    const {eid, data} = component
    const dt = world.time.delta / 1000

    if (data.litFor > 0) {
      data.litFor -= dt
      if (data.litFor <= 0) {
        data.level = 0
        world.events.dispatch(world.events.globalId, LEDS, {on: false, intensity: 0})
        send(eid, {leds: false, intensity: 0})
      }
      return
    }

    // Pressure bleeds off, so charging has to be deliberate.
    if (data.level > 0) {
      data.level = Math.max(0, data.level - DECAY_PER_SECOND * dt)
      world.events.dispatch(world.events.globalId, CHARGE, {level: data.level})
    }
  },
  stateMachine: ({world, eid, schemaAttribute, dataAttribute}) => {
    const {tapTarget} = schemaAttribute.get(eid)

    const tap = () => {
      const cursor = dataAttribute.cursor(eid)
      if (cursor.litFor > 0) {
        return
      }
      cursor.level = clamp01(cursor.level + CHARGE_PER_TAP)
      world.events.dispatch(world.events.globalId, CHARGE, {level: cursor.level})

      if (cursor.level >= 1) {
        cursor.litFor = LIT_SECONDS
        world.events.dispatch(world.events.globalId, ERUPT, {power: 1})
        world.events.dispatch(world.events.globalId, LEDS, {on: true, intensity: 1})
        send(eid, {leds: true, intensity: 1})
      }
    }

    ecs.defineState('default')
      .initial()
      .listen(tapTarget, ecs.input.UI_CLICK, tap)
      .listen(tapTarget, ecs.input.SCREEN_TOUCH_START, tap)
  },
})
