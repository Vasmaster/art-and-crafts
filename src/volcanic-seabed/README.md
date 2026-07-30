# Volcanic Seabed — A.R.T. & Crafts prototype

A working proof of concept for the first of the three phygital blocks in the
project plan: a hand-made resin block whose WebAR layer shows the magma, ash and
heat the resin can only hint at.

Nothing here is final art. It is a greybox that proves the pipeline end to end —
image target, block-aligned volume, interactive variable, hardware seam — so the
resin work and the 3D work can proceed against something real.

![Erupting](../../docs/preview-erupting.png)

## What runs

| Piece | File | What it does |
| --- | --- | --- |
| Scene | `volcanic-seabed.ts` | Builds the seamount, seabed, lava seams, LEDs and block wireframe; drives everything from a single 0–1 heat value |
| Particles | `swarm.ts` | Ash, embers, gas and marine snow |
| Controls | `seabed-hud.ts` | Cooler / hotter buttons, temperature readout, heat bar |
| Hardware seam | `tectonic-charge.ts` | Tap-to-charge; fires the eruption and the LED signal, optionally over WebSocket |
| Contract | `events.ts` | The four global events the pieces talk over |

The parts never reference each other directly — they exchange global events. That
is deliberate: the induction/ESP32 loop has to be removable for workshops where
there is no coil on the table, without touching the rest.

## How the digital layer is bound to the physical block

This is the technical claim in §3 of the project plan, and it is the thing to
demonstrate, so it is worth being precise about.

Everything is authored in **block units: 1 unit = the width of the printed image
target = 100 mm**. The resin block (10 x 10 x 7 cm) is therefore exactly
1.0 x 0.7 x 1.0 units, and the cyan wireframe you can see is that volume, drawn
at its true size. Turn it off with `showVolume` once it has made its point.

The content sits under **Seabed Root**, which carries a +90° rotation about X.
An 8th Wall image target's local +Z points *out of* the printed page, so that
rotation is what lets the scene be authored the normal way (Y up) and still stand
up correctly out of the table. If you add your own content, put it under that
same root and author it Y-up.

## Printing the target

`print/volcano-base.png` is a generated stand-in for the hand-painted base:
1200 x 1600 px, so it prints at about 100 x 133 mm at 300 dpi (fits A6). Print it
matte — gloss paper and resin both reflect, which is what makes this problem hard.
Lay the block on it, or beside it.

When the real base plate is painted, photograph it flat in even light and run:

```bash
python tools/make_image_target.py photos/my-base.jpg volcano-base
```

That regenerates `image-targets/volcano-base.*` in place and nothing else has to
change. **This works without the Studio desktop app or any cloud service**: an
image target in this project is only a small JSON file plus a 480x640 greyscale
copy of the image, and the engine extracts features from it at runtime. Importing
through the Studio UI is still fine — it produces the same files.

To use a different target name, change it in three places: the file name, the
`require` in `src/app.js`, and the `imageTargetName` parameter on both the
**Volcano Base** object and the **Volcanic Seabed** component.

## Tuning

Select **Seabed Root** in Studio and the component's parameters are in the
Inspector:

- `startTemperature` — 0–1, where the vent begins
- `rockCount` / `seed` — reroll the boulder field
- `showVolume` — the block wireframe
- `hideUntilFound` — leave on for AR; turn **off** to see the scene on desktop,
  where there is no tracker to fire an image-found event

Sizes, colours and particle behaviour are constants at the top of
`volcanic-seabed.ts` and in each `createSwarm` call. They are ordinary numbers in
one file on purpose — this is the layer you are meant to rewrite.

## Driving the real LEDs

Set `websocketUrl` on the **Tectonic Charge** component to `ws://<esp32-ip>:81`.
On a full charge it sends:

```json
{"leds": true, "intensity": 1.0}
```

and `{"leds": false, "intensity": 0}` when the charge lapses. Leave the URL blank
and the demo is screen-only; a failed connection logs a warning and carries on.
Note that a `ws://` socket from an `https://` page is blocked by browsers — serve
the experience over plain HTTP on the local network for hardware sessions, or
terminate TLS on the ESP32.

## Two things that cost time, so they are written down

**`ecs.ParticleEmitter` is not used here.** Its forces are applied in world space
with an implicit gravity, which fights an image-target scene where "up" is the
target normal rather than world +Y — ash ended up several metres under the table.
It also only reads its emission rate when it restarts, so a rate that responds to
temperature means bouncing the emitter every time. `swarm.ts` replaces it with
about eighty lines that run in local space.

**The UI font atlas is ASCII only.** `°`, `−` and emoji render as blank boxes.
Hence "MAGMA TEMPERATURE (deg C)" rather than "°C".
