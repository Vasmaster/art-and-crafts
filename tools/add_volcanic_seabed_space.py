"""Add (or rebuild) the "Volcanic Seabed" space in src/.expanse.json.

Studio stores the whole scene graph in one JSON file, so a space can be authored
here as easily as in the editor — and unlike the editor, this is diffable and
repeatable. Run it once; after that, edit the space in Studio like any other.

Re-running deletes and recreates every object it owns, so anything you tweak in the
editor inside this space will be lost. Everything outside the space is untouched.

Usage:
    python tools/add_volcanic_seabed_space.py
"""

import json
import os
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
SCENE = os.path.join(os.path.dirname(HERE), 'src', '.expanse.json')

NAMESPACE = uuid.UUID('5f1d0a4e-7c2b-4f6a-9d31-0b8e6a2c4d70')
SPACE_NAME = 'Volcanic Seabed'
IMAGE_TARGET = 'volcano-base'

# Rotation that maps content authored Y-up onto an image target whose local +Z points
# out of the printed page: +90 degrees about X.
Q_STAND_UP = [0.7071067811865476, 0, 0, 0.7071067811865476]
Q_ID = [0, 0, 0, 1]

INK = '#0d1420'
INK_SOFT = '#16202f'
EDGE = '#2c4257'
TEXT = '#e8f1f6'
DIM = '#8fa6b5'
LAVA = '#ff7a22'
COIL = '#5ad2e6'


def uid(key):
    """Stable ids, so re-running produces the same graph instead of orphan objects."""
    return str(uuid.uuid5(NAMESPACE, key))


objects = {}


def obj(key, name, parent, *, pos=(0, 0, 0), rot=None, scale=(1, 1, 1), order=0, **extra):
    o = {
        'id': uid(key),
        'name': name,
        'parentId': parent,
        'position': list(pos),
        'rotation': list(rot or Q_ID),
        'scale': list(scale),
        'geometry': None,
        'material': None,
        'components': {},
        'order': order,
    }
    o.update(extra)
    objects[o['id']] = o
    return o['id']


def component(owner_id, key, name, parameters):
    objects[owner_id]['components'][uid(key)] = {
        'id': uid(key),
        'name': name,
        'parameters': parameters,
    }


def entity_ref(target_id):
    return {'type': 'entity', 'id': target_id}


def ui(**props):
    return {'ui': props}


def build():
    space_id = uid('space')

    # --- camera and lighting -------------------------------------------------
    camera_id = obj(
        'camera', 'Camera', space_id,
        pos=(0, 0.9, 1.7), rot=[-0.1736481776669303, 0, 0, 0.984807753012208], order=1,
        camera={
            'type': 'perspective',
            'xr': {
                'type': 'perspective',
                'xrCameraType': 'world',
                'phone': 'AR',
                'desktop': '3D',
                'headset': 'AR',
                'world': {'disableWorldTracking': False},
            },
        },
    )

    # Cool, slightly blue key light: the scene is meant to read as deep water.
    obj('light-ambient', 'Ambient Light', space_id, pos=(0, 3, 0), order=2,
        light={'type': 'ambient', 'r': 150, 'g': 186, 'b': 214, 'intensity': 1.3})
    obj('light-key', 'Directional Light', space_id, pos=(6, 14, 8), order=3,
        light={'type': 'directional', 'r': 235, 'g': 244, 'b': 255, 'intensity': 1.5})
    obj('light-fill', 'Fill Light', space_id, pos=(-8, 4, -6), order=4,
        light={'type': 'directional', 'r': 90, 'g': 130, 'b': 170, 'intensity': 0.7})

    # --- tracked content -----------------------------------------------------
    target_id = obj('target', 'Volcano Base', space_id, order=5,
                    imageTarget={'name': IMAGE_TARGET})

    seabed_id = obj('seabed-root', 'Seabed Root', target_id, rot=Q_STAND_UP, order=6)
    component(seabed_id, 'seabed-component', 'Volcanic Seabed', {
        'imageTargetName': IMAGE_TARGET,
        'startTemperature': 0.35,
        'rockCount': 34,
        'seed': 7,
        'showVolume': True,
        'hideUntilFound': True,
    })

    # --- heads-up display ----------------------------------------------------
    hud_id = obj('hud', 'Seabed HUD', space_id, order=10, hidden=False, **ui(
        type='overlay', position='absolute', left=16, bottom=16,
        flexDirection='column', gap=8, alignItems='flex-start',
        justifyContent='flex-end', width=320, height=228,
    ))

    def panel(key, name, parent, order, **props):
        base = dict(
            type='3d', background=INK, backgroundOpacity=0.86, borderColor=EDGE,
            borderWidth=1, borderRadius=12, padding='10', width=320,
        )
        base.update(props)
        return obj(key, name, parent, order=order, hidden=False, **ui(**base))

    def label(key, name, parent, order, text, *, size=14, colour=TEXT, **props):
        base = dict(
            width=296, height=int(size * 1.6), text=text, color=colour,
            fontSize=size, textAlign='left', verticalTextAlign='center',
        )
        base.update(props)
        return obj(key, name, parent, order=order, **ui(**base))

    # Readout: what the block is and how hot it currently is.
    readout = panel('hud-readout', 'Readout', hud_id, 1, flexDirection='column', gap=2, height=88)
    label('hud-title', 'Title', readout, 1, 'MAGMA TEMPERATURE  (deg C)', size=12, colour=DIM)
    temp_id = label('hud-temp', 'Temperature', readout, 2, '800', size=30, colour=LAVA, height=36)
    status_id = label('hud-status', 'Status', readout, 3, 'Vent stable', size=12, colour=DIM)

    # Heat bar. The fill's width is what the HUD component animates.
    heat_track = panel('hud-heat-track', 'Heat Track', hud_id, 2,
                       background=INK_SOFT, borderRadius=6, padding='0',
                       height=10, flexDirection='row', justifyContent='flex-start')
    heat_fill = obj('hud-heat-fill', 'Heat Fill', heat_track, order=1, **ui(
        type='3d', width='35%', height=10, background=LAVA, borderRadius=6,
        ignoreRaycast=True,
    ))

    # Temperature buttons.
    buttons = obj('hud-buttons', 'Buttons', hud_id, order=3, **ui(
        type='3d', width=320, height=46, flexDirection='row', gap=8,
        justifyContent='flex-start', alignItems='center',
    ))

    # Fixed widths, not flex: a flexed button collapsed and wrapped its label to one
    # letter per line. The UI font atlas is ASCII-only, so no dashes or symbols.
    def button(key, name, parent, order, text, width, *, colour=TEXT):
        holder = obj(key, name, parent, order=order, hidden=False, **ui(
            type='3d', width=width, height=46, background=INK, backgroundOpacity=0.92,
            borderColor=EDGE, borderWidth=1, borderRadius=12,
            flexDirection='row', alignItems='center', justifyContent='center',
        ))
        obj(f'{key}-text', f'{name} Text', holder, order=1, **ui(
            width=width - 16, height=22, text=text, color=colour, fontSize=15,
            textAlign='center', verticalTextAlign='center', ignoreRaycast=True,
        ))
        return holder

    cooler_id = button('hud-cooler', 'Cooler', buttons, 1, '-  COOLER', 156)
    hotter_id = button('hud-hotter', 'Hotter', buttons, 2, 'HOTTER  +', 156)

    charge_id = button('hud-charge', 'Charge', hud_id, 4, 'CHARGE THE VENT', 320, colour=COIL)

    charge_track = panel('hud-charge-track', 'Charge Track', hud_id, 5,
                         background=INK_SOFT, borderRadius=5, padding='0',
                         height=8, flexDirection='row', justifyContent='flex-start')
    charge_fill = obj('hud-charge-fill', 'Charge Fill', charge_track, order=1, **ui(
        type='3d', width='0%', height=8, background=COIL, borderRadius=5,
        ignoreRaycast=True,
    ))

    component(hud_id, 'hud-component', 'Seabed HUD', {
        'coolerButton': entity_ref(cooler_id),
        'hotterButton': entity_ref(hotter_id),
        'temperatureText': entity_ref(temp_id),
        'statusText': entity_ref(status_id),
        'heatBarFill': entity_ref(heat_fill),
        'chargeBarFill': entity_ref(charge_fill),
        'startTemperature': 0.35,
    })
    component(hud_id, 'charge-component', 'Tectonic Charge', {
        'tapTarget': entity_ref(charge_id),
        # Set to ws://<esp32-ip>:81 to drive the real induction coil. Blank = screen only.
        'websocketUrl': '',
    })

    return space_id, camera_id


def main():
    with open(SCENE, encoding='utf-8') as f:
        scene = json.load(f)

    space_id, camera_id = build()

    # Drop anything a previous run created, then splice the new objects in.
    owned = set(objects) | {space_id}
    scene['objects'] = {
        oid: o for oid, o in scene['objects'].items()
        if oid not in owned and o.get('parentId') != space_id
    }
    scene['objects'].update(objects)

    scene['spaces'][space_id] = {
        'id': space_id,
        'name': SPACE_NAME,
        'activeCamera': camera_id,
        'reflections': {
            'type': 'url',
            'url': 'https://cdn.8thwall.com/web/assets/envmap/basic_env_map-m9hqpneh.jpg',
        },
    }
    scene['entrySpaceId'] = space_id

    with open(SCENE, 'w', encoding='utf-8') as f:
        json.dump(scene, f, indent=2)

    print(f'space "{SPACE_NAME}" -> {space_id}')
    print(f'{len(objects)} objects written to {SCENE}')
    print('entry space set to Volcanic Seabed')


if __name__ == '__main__':
    main()
