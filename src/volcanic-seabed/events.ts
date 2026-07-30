// Message contract between the pieces of the Volcanic Seabed demo.
//
// Everything talks over global world events rather than direct references, so the
// HUD, the scene and the hardware bridge can each be replaced or removed on their
// own. That matters here: the induction/ESP32 loop described in the project plan is
// meant to be swappable for a pure-screen version during workshops.

/** HUD -> scene. {value: 0..1} absolute setting of the magma temperature. */
export const SET_TEMPERATURE = 'seabed.temperature'

/** HUD or charge component -> scene. {power: 0..1} one-off eruption burst. */
export const ERUPT = 'seabed.erupt'

/** Scene -> HUD. Broadcast every frame the scene updates. */
export const STATE = 'seabed.state'

/** Charge component -> hardware bridge and scene. {on: boolean, intensity: 0..1} */
export const LEDS = 'seabed.leds'

/** Charge component -> HUD. {level: 0..1} */
export const CHARGE = 'seabed.charge'

export interface StateEvent {
  temperature: number   // 0..1
  celsius: number       // mapped for display
  erupting: boolean
  tracked: boolean
}
