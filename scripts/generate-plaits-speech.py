#!/usr/bin/env python3
"""Pack Plaits Speech ROM (MIT, Emilie Gillet / Mutable Instruments).

Sources (downloaded under scripts/plaits-speech-src/):
  plaits/dsp/speech/lpc_speech_synth_words.cc
  plaits/resources.cc → lut_lpc_excitation_pulse[640]

Output: js/worklets/plaits-speech.bin

Layout (little-endian):
  magic[4] = b'PLSP'
  version u32 = 1
  excitation int8[640]
  num_banks u32 = 5
  bank_size[5] u32
  bank_bytes... (concatenated uint8 bitstreams)
"""
from __future__ import annotations

import re
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(__file__).resolve().parent / 'plaits-speech-src'
OUT = ROOT / 'js' / 'worklets' / 'plaits-speech.bin'

BANK_SIZES = [1233, 900, 1552, 2524, 4802]


def parse_c_uint8_array(text: str, name: str, expected: int) -> bytes:
    start = text.find(f'const uint8_t {name}[]')
    if start < 0:
        raise SystemExit(f'array {name}[] not found')
    brace = text.find('{', start)
    end = text.find('};', brace)
    if brace < 0 or end < 0:
        raise SystemExit(f'array {name}[] braces not found')
    body = re.sub(r'//.*?$', '', text[brace + 1:end], flags=re.M)
    clean = [int(x, 0) for x in re.findall(r'0x[0-9a-fA-F]+|\b\d+\b', body)]
    if len(clean) != expected:
        raise SystemExit(f'{name}: got {len(clean)} bytes, want {expected}')
    return bytes(clean)


def main() -> None:
    words_cc = (SRC / 'lpc_speech_synth_words.cc').read_text()
    pulse_txt = (SRC / 'lut_lpc_excitation_pulse.txt').read_text().strip()
    pulse = [int(x) for x in pulse_txt.split(',') if x.strip()]
    if len(pulse) != 640:
        raise SystemExit(f'excitation pulse len {len(pulse)} != 640')

    banks = []
    for i, size in enumerate(BANK_SIZES):
        banks.append(parse_c_uint8_array(words_cc, f'bank_{i}', size))

    out = bytearray()
    out += b'PLSP'
    out += struct.pack('<I', 1)
    out += struct.pack('<' + 'b' * 640, *pulse)
    out += struct.pack('<I', 5)
    for b in banks:
        out += struct.pack('<I', len(b))
    for b in banks:
        out += b

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(out)
    print(f'wrote {OUT} ({len(out)} bytes)')
    print('banks:', [len(b) for b in banks], 'sum', sum(map(len, banks)))


if __name__ == '__main__':
    main()
