#!/usr/bin/env python3
"""Generate Plaits waveshaper / fold LUTs as float32 little-endian binary.

Sources (MIT, Copyright 2016 Emilie Gillet):
  plaits/resources/lookup_tables.py

Output layout (js/worklets/plaits-waveshaper.bin):
  ws[6][257] float32   — bipolar waveshaper tables (inverse_tan..double_bump_sentinel)
  fold[516] float32    — bipolar fold
  fold2[516] float32   — diode fold
  stiffness[65] float32
"""
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'js' / 'worklets' / 'plaits-waveshaper.bin'

WAVESHAPER_SIZE = 128
x = np.arange(0, WAVESHAPER_SIZE + 1) / float(WAVESHAPER_SIZE)

linear = x
tan = np.arctan(8 * np.cos(np.pi * x))
scale = tan.max()
fade_crop = np.minimum(1.0, 4.0 - 4.0 * x)
bump = (1.0 - np.cos(np.pi * x * 1.5)) * (1.0 - np.cos(np.pi * fade_crop)) / 4.5
double_bump = np.sin(np.pi * x * 1.5)
inverse_sin = np.arccos(np.clip(1 - 2 * x, -1, 1)) / np.pi
inverse_tan = np.arccos(np.clip(np.tan(scale * (1.0 - 2.0 * x)) / 8.0, -1, 1)) / np.pi


def flip(arr):
    arr = np.asarray(arr, dtype=np.float64)
    out = np.concatenate([-arr[WAVESHAPER_SIZE:0:-1], arr])
    return (out / np.abs(out).max()).astype(np.float32)


ws_tables = np.stack([
    flip(inverse_tan),
    flip(inverse_sin),
    flip(linear),
    flip(bump),
    flip(double_bump),
    flip(double_bump),
], axis=0)  # [6, 257]

FOLD_SIZE = 512
xf = np.arange(0, FOLD_SIZE + 4) / (FOLD_SIZE / 2.0) - 1.0
xf[-1] = xf[-2]
sine = np.sin(8 * np.pi * xf)
window = np.exp(-xf * xf * 4) ** 2
bipolar_fold = sine * window + np.arctan(3 * xf) * (1 - window)
bipolar_fold /= np.abs(bipolar_fold).max()
fold = bipolar_fold.astype(np.float32)


def deadband(v_in, r_in, r_load, r_fb=150.0e3, v_sat=10.47):
    v_out = -r_fb / r_in * v_in
    v_out = np.clip(v_out, -v_sat, v_sat)
    return (v_in * r_fb * r_load + v_out * r_in * r_load) / (
        r_fb * r_load + r_in * r_load + r_in * r_fb)


def diode(v):
    return 0.7 * v / (0.3 + np.abs(v))


v_in = xf * 12.0
stage_1 = deadband(v_in, 10e3, 100e3)
stage_2 = deadband(v_in, 49.9e3, 44.2e3)
stage_3 = deadband(v_in, 91e3, 18e3)
stage_4 = deadband(v_in, 30e3, 71.4e3)
stage_5 = deadband(v_in, 68e3, 33.0e3)
stage_45 = -33.0 / 71.4 * stage_4 - 33.0 / 33.0 * stage_5 - 33.0 / 240.0 * v_in
v_out = diode(
    -150.0 / 100.0 * stage_1
    - 150.0 / 44.2 * stage_2
    - 150.0 / 18.0 * stage_3
    - 150.0 / 33.0 * stage_45
)
fold2 = (v_out / np.abs(v_out).max()).astype(np.float32)

structure = np.arange(0, 65) / 64.0
stiffness = structure.copy()
for i, g in enumerate(structure):
    if g < 0.25:
        g = 0.25 - g
        stiffness[i] = -g * 0.25
    elif g < 0.3:
        stiffness[i] = 0.0
    elif g < 0.9:
        g = (g - 0.3) / 0.6
        stiffness[i] = 0.01 * 10 ** (g * 2.005) - 0.01
    else:
        g = ((g - 0.9) / 0.1) ** 2
        stiffness[i] = 1.5 - np.cos(g * np.pi) / 2.0
stiffness[-1] = 2.0
stiffness[-2] = 2.0
stiffness = stiffness.astype(np.float32)

OUT.parent.mkdir(parents=True, exist_ok=True)
blob = b''.join([
    ws_tables.astype('<f4').tobytes(),
    fold.astype('<f4').tobytes(),
    fold2.astype('<f4').tobytes(),
    stiffness.astype('<f4').tobytes(),
])
OUT.write_bytes(blob)
print(f'wrote {OUT} ({len(blob)} bytes)')
print(f'  ws {ws_tables.shape}, fold {fold.shape}, fold2 {fold2.shape}, stiff {stiffness.shape}')
