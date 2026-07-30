import * as ecs from '@8thwall/ecs'

import {CHARGE, SET_TEMPERATURE, STATE, StateEvent} from './events'

// The on-screen controls from Fig. 2 of the project plan: the child changes a
// variable and watches the block in their hands respond. The component owns nothing
// but the slider value — the scene is driven entirely through events.

const STEP = 0.125

// The UI font atlas is ASCII-only: no dashes, degree signs or arrows.
const STATUS_TEXT = [
  'Point the camera at the painted base',
  'Eruption - ash column rising',
  'Vent stable',
]

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

ecs.registerComponent({
  name: 'Seabed HUD',
  schema: {
    coolerButton: ecs.eid,
    hotterButton: ecs.eid,
    temperatureText: ecs.eid,
    statusText: ecs.eid,
    heatBarFill: ecs.eid,
    chargeBarFill: ecs.eid,
    startTemperature: ecs.f32,
  },
  schemaDefaults: {
    startTemperature: 0.35,
  },
  data: {
    value: ecs.f32,
    lastCelsius: ecs.i32,
    lastStatus: ecs.i32,
  },
  add: (world, component) => {
    component.data.value = component.schema.startTemperature
    component.data.lastCelsius = -1
    component.data.lastStatus = -1
    world.events.dispatch(world.events.globalId, SET_TEMPERATURE, {
      value: component.schema.startTemperature,
    })
  },
  stateMachine: ({world, eid, schemaAttribute, dataAttribute}) => {
    const {
      coolerButton, hotterButton,
      temperatureText, statusText, heatBarFill, chargeBarFill,
    } = schemaAttribute.get(eid)

    const push = (next: number) => {
      const value = clamp01(next)
      dataAttribute.cursor(eid).value = value
      world.events.dispatch(world.events.globalId, SET_TEMPERATURE, {value})
      ecs.Ui.set(world, heatBarFill, {width: `${Math.round(value * 100)}%`})
    }

    ecs.defineState('default')
      .initial()
      .onEnter(() => {
        push(dataAttribute.cursor(eid).value)
      })
      .listen(coolerButton, ecs.input.UI_CLICK, () => {
        push(dataAttribute.cursor(eid).value - STEP)
      })
      .listen(hotterButton, ecs.input.UI_CLICK, () => {
        push(dataAttribute.cursor(eid).value + STEP)
      })
      .listen(world.events.globalId, CHARGE, (e) => {
        const {level} = e.data as any
        ecs.Ui.set(world, chargeBarFill, {width: `${Math.round(clamp01(level) * 100)}%`})
      })
      .listen(world.events.globalId, STATE, (e) => {
        const {celsius, erupting, tracked} = e.data as StateEvent
        const cursor = dataAttribute.cursor(eid)
        // Only touch the UI when a label actually changes — rebuilding text layout
        // on every broadcast is visible as a stutter on older phones.
        if (celsius !== cursor.lastCelsius) {
          cursor.lastCelsius = celsius
          ecs.Ui.set(world, temperatureText, {text: `${celsius}`})
        }
        const status = !tracked ? 0 : erupting ? 1 : 2
        if (status !== cursor.lastStatus) {
          cursor.lastStatus = status
          ecs.Ui.set(world, statusText, {text: STATUS_TEXT[status]})
        }
      })
  },
})
