#!/usr/bin/env python3
"""Regenerate js/worklets/plaits-wavetables.bin from Mutable Instruments Plaits sources.

Sources (MIT License, Copyright 2016 Emilie Gillet):
  https://github.com/pichenettes/eurorack/blob/master/plaits/resources/wavetables.py
  https://github.com/pichenettes/eurorack/blob/master/plaits/resources/waves.bin

Bank D uses Plaits' default shuffle: index = (wave * 101) % 192
Output: float32 little-endian, shape [4 banks][64 waves][128 samples]
Each wave is equal-RMS normalized then first-order integrated (Plaits AA path).
"""
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
WAVES_BIN = Path(__file__).with_name('plaits-waves.bin')
OUT_BIN = ROOT / 'js' / 'worklets' / 'plaits-wavetables.bin'

WAVETABLE_SIZE = 128
BRAIDS_WAVES = np.frombuffer(WAVES_BIN.read_bytes(), dtype=np.uint8)


def sine(frequency):
    t = np.arange(0, WAVETABLE_SIZE) / float(WAVETABLE_SIZE)
    if frequency >= WAVETABLE_SIZE / 2:
        return t * 0
    return np.sin(2 * np.pi * t * frequency)


def comb(n):
    x = 0
    for i in range(n):
        x += sine(i + 1)
    return x


def pair(n):
    x = 0
    for i in range(n):
        x += sine(i + 1) * (i + 0.5) / (n - 1.0)
        x += sine((i + 1) * 4) * (i + 0.5) / (n - 1.0) * 0.5
    return x


def tri(n, f=1):
    x = 0
    for i in range(n):
        x += sine((2 * i + 1) * f) / (2 * i + 1) ** 2.0
    return x


def tri_stack(n):
    x = 0
    for i in range(n):
        x += tri(15 + 5 * n, i + n / 3)
    return x


def saw(n, f=1):
    x = 0
    for i in range(n):
        x += sine((i + 1) * f) / (i + 1)
    return x


def quadra(n):
    x = 0
    for harmonic, amplitude in zip(range(4), [1, 0.5, 1, 0.5]):
        x += sine(2 * n + 2 * harmonic + 1) * amplitude
    return x


def drawbars(bars):
    pipes = [1.0, 3.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 16.0]
    x = 0
    for intensity, frequency in zip(bars, pipes):
        x += int(intensity) / 8.0 * sine(frequency)
    return x


def pulse(duty):
    t = np.arange(0, WAVETABLE_SIZE) / float(WAVETABLE_SIZE)
    out = np.where(t < duty, -1.0, 1.0)
    out[-1] = out[0]
    return -out


def burst(duty):
    t = np.arange(0, WAVETABLE_SIZE) / float(WAVETABLE_SIZE)
    d = duty ** 0.5
    out = np.where(t < d, -1.0, 0.0)
    out[-1] = out[0]
    return -out * sine(1.0 / duty)


def trisaw(harmonic):
    return tri(80) + saw(80, harmonic) * (1 if harmonic != 1 else 0.25) * 0.5


def sawtri(harmonic):
    return saw(80) * 0.5 + tri(80, harmonic) * (1 if harmonic != 1 else 0.25)


def bandpass_formant(ratio):
    t = np.arange(0, WAVETABLE_SIZE) / float(WAVETABLE_SIZE)
    return sine(ratio * 1.5) * (1.0 - t) * 0.5


def sine_power(power):
    x = sine(1.0) + saw(16)
    p = 2.0 ** power
    return np.sign(x) * (np.abs(x) ** p)


def formant_f(index):
    formant_1 = 3.9 * (index + 1) / 8.0
    formant_2 = formant_1 * (1.0 - np.cos(formant_1 * np.pi * 0.8))
    t = np.arange(0, WAVETABLE_SIZE) / float(WAVETABLE_SIZE)
    amplitude_1 = (1.0 - t) ** 0.2 * np.exp(-4.0 * t)
    amplitude_2 = (1.0 - t) ** 0.2 * np.exp(-2.0 * t)
    formant_3 = sine(1 + 2.8 * (formant_2 + formant_1)) * amplitude_2 * 1.7
    f1 = sine(1 + 3 * formant_1) * amplitude_1
    f2 = sine(1 + 4 * formant_2) * amplitude_2 * 1.5
    f = f1 + f2 + formant_3
    return f - (f.max() + f.min()) / 2.0


def distort(x):
    return np.arctan(x * 8.0) / np.pi


def digi_formant_f(index):
    formant_1 = 3.9 * (index + 1) / 8.0
    formant_2 = formant_1 * (1.0 - np.cos(formant_1 * np.pi * 0.8))
    t = np.arange(0, WAVETABLE_SIZE) / float(WAVETABLE_SIZE)
    amplitude_1 = (1.0 - t) ** 0.2 * np.exp(-4.0 * t)
    amplitude_2 = (1.0 - t) ** 0.2 * np.exp(-2.0 * t)
    formant_3 = distort(sine(1 + 2.9 * (formant_2 + formant_1))) * amplitude_2 * 0.7
    f1 = distort(sine(1 + 3.2 * formant_1)) * amplitude_1
    f2 = distort(sine(1 + 4.1 * formant_2)) * amplitude_2 * 0.7
    f = f1 + f2 + formant_3
    return f - (f.max() + f.min()) / 2.0


def make_family(fn, arguments):
    return [np.asarray(fn(a), dtype=np.float64) for a in arguments]


def make_braids_family(indices, fix=True):
    family = []
    for i in indices:
        start = i * 129
        s = BRAIDS_WAVES[start:start + 128].astype(np.float64) - 128.0
        sf = np.fft.rfft(s)
        if fix:
            sf = np.abs(sf) * np.exp(-1j * np.pi / 2.0)
        family.append(np.fft.irfft(sf, WAVETABLE_SIZE))
    return family


# Target RMS for level-stable morphing (analog saw ≈ 0.577).
TARGET_RMS = 0.5


def normalize_wave(wave, rms_target=TARGET_RMS):
    """DC-remove, then equal-RMS normalize (peak-capped softly)."""
    x = np.asarray(wave, dtype=np.float64).copy()
    x -= x.mean()
    rms = np.sqrt(np.mean(x * x))
    if rms > 1e-12:
        x *= rms_target / rms
    # Soft peak limit so integrated AA stays well-behaved
    peak = np.abs(x).max()
    if peak > 1.25:
        x *= 1.25 / peak
    return x.astype(np.float64)


def integrate_wave(wave):
    """First-order integrated wavetable (Plaits / Franck & Välimäki).

    Stores WAVE_SIZE samples of demeaned cumsum, scaled so that differentiating
    with Differentiator recovers approximately the original float waveform.
    Scale matches Plaits' (4 / WAVE_SIZE) relative to unit waves.
    """
    x = np.asarray(wave, dtype=np.float64)
    # Duplicate wrap samples for hermite-safe endpoints (stored as length WAVE_SIZE;
    # worklet wraps indices). Integrate one period.
    integ = np.cumsum(x)
    integ -= integ.mean()
    integ *= (4.0 / WAVETABLE_SIZE)
    return integ.astype(np.float32)


def main():
    bank_1 = []
    bank_1 += make_family(sine, [1, 2, 3, 4, 5, 6, 7, 8])
    bank_1 += make_family(sine, [2, 3, 4, 6, 8, 12, 16, 24])
    bank_1 += make_family(quadra, [2, 3, 4, 6, 8, 12, 16, 24])
    bank_1 += make_family(comb, [2, 3, 5, 8, 13, 21, 34, 55])
    bank_1 += make_family(pair, [2, 4, 6, 8, 10, 12, 14, 16])
    bank_1 += make_family(tri_stack, [2, 4, 6, 8, 10, 12, 14, 16])
    bank_1 += make_family(drawbars, [
        '688600000', '686040000', '666806000', '655550600',
        '665560060', '688500888', '660000888', '060000046'])
    bank_1 += make_family(drawbars, [
        '867000006', '888876788', '668744354', '448644054',
        '327645222', '204675300', '002478500', '002050321'])

    bank_2 = []
    bank_2 += make_family(trisaw, [1, 1.5, 2, 3, 4, 4.5, 5, 8])
    bank_2 += make_family(sawtri, [1, 1.5, 2, 3, 4, 4.5, 5, 8])
    bank_2 += make_family(burst, [0.5, 0.4, 1 / 3.0, 0.25, 0.2, 0.125, 1 / 16.0, 1 / 32.0])
    bank_2 += make_family(bandpass_formant, [2.0, 3.0, 4.0, 6.0, 8.0, 9.0, 10.0, 16.0])
    bank_2 += make_family(formant_f, range(8))
    bank_2 += make_family(digi_formant_f, range(8))
    bank_2 += make_family(pulse, [0.5, 0.4, 1 / 3.0, 0.25, 0.2, 0.125, 1 / 16.0, 1 / 32.0])
    bank_2 += make_family(sine_power, range(8))

    bank_3 = []
    bank_3 += make_braids_family([0, 2, 4, 6, 8, 10, 12, 14])
    bank_3 += make_braids_family([32, 34, 36, 38, 40, 42, 44, 46])
    bank_3 += make_braids_family([176, 189, 191, 193, 195, 197, 199, 201])
    bank_3 += make_braids_family([203, 204, 205, 206, 207, 208, 209, 211])
    bank_3 += make_braids_family([220, 222, 224, 226, 228, 230, 232, 234])
    bank_3 += make_braids_family([236, 238, 240, 242, 244, 246, 248, 250])
    bank_3 += make_braids_family([172, 173, 174, 175, 176, 177, 178, 179], False)
    bank_3 += make_braids_family([180, 181, 182, 183, 184, 185, 186, 187], False)

    all_waves = bank_1 + bank_2 + bank_3
    assert len(all_waves) == 192
    base = np.stack([normalize_wave(w) for w in all_waves], axis=0)
    bank_d = np.stack([base[(i * 101) % 192] for i in range(64)], axis=0)
    banks_raw = np.stack([base[0:64], base[64:128], base[128:192], bank_d], axis=0)
    # Integrate each wave (Plaits anti-aliased wavetable path)
    banks = np.empty_like(banks_raw, dtype=np.float32)
    for b in range(4):
        for w in range(64):
            banks[b, w] = integrate_wave(banks_raw[b, w])
    OUT_BIN.parent.mkdir(parents=True, exist_ok=True)
    OUT_BIN.write_bytes(banks.astype('<f4').tobytes())
    rmses = [float(np.sqrt(np.mean(banks_raw[b, w] ** 2))) for b in range(4) for w in range(0, 64, 8)]
    print(f'wrote {OUT_BIN} ({OUT_BIN.stat().st_size} bytes, shape {banks.shape})')
    print(f'pre-integrate RMS sample mean={np.mean(rmses):.4f} (target {TARGET_RMS})')


if __name__ == '__main__':
    main()
