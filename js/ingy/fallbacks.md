# Fallbacks between the web app and Bare Metal

Rule: **never block the groove.** An app that lacks a feature plays the nearest thing it has, keeps the field in
the document untouched, and writes it back out. It may show a small "made in the app" note; it never refuses a file.

## Web app opening a Bare Metal file

| Field | Web plays | Field kept |
|---|---|---|
| `osc-pw-N` | that duty cycle when the wave is square (`0.5` is a square; other waves ignore it) | yes |
| `osc-pwm-N`, `osc-pwm-src-N` (PWM depth / source) | no extra modulation; the stored `osc-pw-N` still sounds | yes |
| `subVol`, `subOctave`, `subWave` | nothing (no sub oscillator) | yes |
| `osc-sync-N` | free-running oscillators | yes |
| `osc-engine-N = digital`, `osc-model-N`, `osc-harmonics/timbre/morph-N` (OSC 2-4 digital) | that slot's analog `osc-type-N` | yes |
| `filterModel` (`moog`, `juno60`, `juno106`, `sh101`, `tb303`), `filterDrive`, `filterKeyTrack` | the web filter with the same `cutoff` / `resonance` | yes |
| `hpfMode`, `hpfPosition`, `hpfCutoff` (Juno-style high-pass) | no high-pass | yes |
| `lfo2*` | nothing | yes |
| `session.params.tuningSystem` other than `scale12`, `edoDivisions`, `session.tuning.scl/kbm` | 12-TET, plus each step's `fine` cents | yes |
| `session.params.scaleSelect` naming a custom scale (`session.tuning.custom`) | scale off (raw step tunes) | yes |
| `session.params.scaleRoot` != 0 | root C | yes |
| `voice.speechBank` | the bank, if the web supports the frame format; otherwise factory speech | yes |
| `mix` before web v1.0 routing | the web's fixed effects chain from the catalog keys | yes |
| `arrangement` | nothing (arrange mode is out of scope) | yes |
| sample rate 48 kHz and up | the browser's rate (not stored in documents) | n/a |

The web codec already knows every key in `params-baremetal.json`: it clamps them and fills defaults, so they
round-trip exactly. The web engine simply never subscribes to them.

## Bare Metal opening a web file

Web files are a subset: every catalog key maps one-to-one to a C++ parameter ID. Things to pick on load:

| Situation | Bare Metal does |
|---|---|
| No `filterModel` (every web file) | default `moog` (`params-baremetal.json`). Integration may tune cutoff/resonance mapping so web grooves sound close |
| `osc1Digital` true with an `osc4Model` | OSC 1 runs Plaititudes with that model (Wave 2; Analog until then) |
| `ingy6` / `multitudes` flags | keyboard poly modes; the sequencer path is unchanged |
| Drum kit `engine: plaits` | Plaititudes drum models (Wave 2); analog 808 until then |

## Plugin / platform limits (Bare Metal)

| Field | When unavailable |
|---|---|
| external plugin inserts in `mix` (agent L) | placeholder slot that passes audio through and keeps the plugin state |
| AUv3 hosting on Android | same placeholder |
