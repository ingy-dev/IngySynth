# `.ingy` document format, version 1

One JSON document format for everything IngySynth saves or shares: the web app's library and
share links, and the Bare Metal app's files. This folder defines it; neither app does.

- **Reference implementation:** `js/ingy-codec.js` (pure JS, browser and Node).
- **C++ port:** `core/format` (agent F0). Must agree with JS on every file in `examples/`.
- **Tests:** `node spec/ingy/test/run.mjs` (JS) and `ctest -R format` (C++).
- **Origin:** the save-system design chat, kept in `docs/history/cursor_ingysynth_save_system_design.md`.
- **Web source of truth for values:** web repo `b67a4d4` (`js/param-catalog.js`, `js/pattern-bank.js`, `js/state.js`, `js/automation.js`).

## Changing this format

`SPEC.md`, the example/expected files and `ingy-codec.js` change in **one commit**; both apps catch up after.
Adding a key never changes `version`. Only a breaking change bumps `version`, with a migration step added to
`MIGRATIONS` in both codecs. Run `node spec/ingy/test/run.mjs --update` after an intentional change and review the diff.

## Kinds

| `kind` | Sections | Replaces on load | Leaves alone |
|---|---|---|---|
| `patch` | `voice` | the instrument (oscillators, filter, envelopes, effects, LFO, drum kit sound) | the sequence |
| `pattern` | `pattern` | P1-P8, drum patterns, Berlin bank, clock params, automation | the instrument |
| `project` | `voice`, `pattern`, `session`, optional `mix`, optional `arrangement` | everything musical | nothing |

Share always sends a `project` of what is playing right now, including unsaved edits.
A section that doesn't belong to the kind is ignored on load (warning `ignored:<section>`) and not written back.

## Document shape

```json
{
  "format": "ingysynth",
  "version": 1,
  "kind": "project",
  "name": "Night bus",
  "by": "ingy",
  "voice":   { "params": {}, "flags": {}, "speechBank": {} },
  "pattern": { "params": {}, "slot": 0, "slots": [], "drumSlot": 0, "drums": [], "berlin": {}, "automation": {}, "song": {} },
  "session": { "params": {}, "xy": {}, "pitchBendRange": 2, "...": "see below" },
  "mix": {},
  "arrangement": {}
}
```

### Top level

| Key | Type | Rule |
|---|---|---|
| `format` | `"ingysynth"` | required; anything else is error `not-ingysynth` |
| `version` | integer >= 1 | missing = 1 (warning `missing:version`); < 1 is error `bad-version`; > 1 loads with warning `newer:version` and the number is kept |
| `kind` | `project` / `patch` / `pattern` | required; anything else is error `unknown-kind` |
| `name`, `by` | string | untrusted: control characters (U+0000-001F, U+007F-009F) and bidi controls (U+202A-202E, U+2066-2069) removed, trimmed, cut to 64 code points. Display with `textContent` only, never as HTML |

Writers may add informational keys such as `savedAt` (ISO 8601) and `app` (`{ "name", "version" }`); they are kept like any unknown key.

### Sections and params

Every non-step key in the web `param-catalog.js`, plus every key in `params-baremetal.json`, belongs to exactly one
section. The full list is `params.md` (generated). `params.json` is generated from the web catalog by
`tools/export-params.mjs`; `params-baremetal.json` is hand-written.

| Section | Keys | Where |
|---|---|---|
| voice | everything not listed below (90 catalog keys + Bare Metal sound keys) | `voice.params` |
| pattern | `tempo`, `slideTime`, `accentAmount`, `gateLength`, `drumModeToggle` | `pattern.params` |
| session | `scaleToggle`, `scaleSelect`, Bare Metal `scaleRoot`, `tuningSystem`, `edoDivisions` | `session.params` |
| slot view | `stepCount`, `division` | not saved as params; they mirror `pattern.slots[pattern.slot]` |
| step | `step-*-N` | not params; they are `pattern.slots[...].steps[N]` |

Each key has one type: `range` = number, `button` = boolean, `select` = string. `division` and `delayTime` are the
strings `"2"`, `"4"`, `"8"`, `"16"` (a number is accepted and converted). `scaleSelect` is a scale **id**, never an index.

A known key found in the wrong section is dropped (warning `misplaced:<path>`). An unknown key is kept verbatim.

### `voice`

| Key | Content |
|---|---|
| `params` | voice-section keys |
| `flags` | settings outside the catalog, from `flags.json` `voiceFlags`: `acid`, `ingy6`, `ingy6Unison`, `ingy6VcaGate`, `multitudes`, `osc1Digital`, `osc1Alt`, `osc1TrigPatched`, `speechUserBank`, `filterEnvInvert`, `lfoAmount`, `drumKit` |
| `speechBank` | optional object, the speech user bank (LPC frames). **File only: never in a link.** Kept verbatim |
| `fm6Bank` | optional object, the six-op User bank loaded from DX7 SysEx (Bare Metal): `name` (string, the source file name) and `data` (standard base64 of the 4096-byte packed 32-voice payload, the bytes between the bulk-dump header and checksum). Played when `osc4Bank` / `osc-bank-N` is `"3"` on `fm6`. **File only: never in a link.** Kept verbatim |

Naming trap: the web's `osc4*` keys (`osc4Model`, `osc4Harmonics`, ...) and `state.osc4*` flags belong to **OSC 1's
digital engine**, not oscillator 4. The file names that flag `osc1Digital`. Bare Metal's per-slot digital keys for
OSC 2-4 are `osc-engine-N`, `osc-model-N`, `osc-harmonics-N`, `osc-timbre-N`, `osc-morph-N` (N = 1..3).

`drumKit` is four drum patches, D1-D4 (lane models `open_hat`, `hihat`, `snare`, `bass_drum`):

| Field | Type | Default |
|---|---|---|
| `engine` | `analog` / `plaits` (`digital` is read as `plaits`) | `analog` |
| `model` | `open_hat` / `hihat` / `snare` / `bass_drum` | the lane's model |
| `tune`, `harmonics`, `morphX` | 0..1 (`tune` is **not** semitones) | 0.5 |
| `morphY` | 0..1 | 0.72 on lane D1, 0.5 elsewhere (by lane, not by model) |
| `alt` | bool | false |
| `trigPatched` | bool | true |
| `choke` | bool | model `open_hat`: true unless the file says `false`. Any other model: always false |
| `vol` | 0..1 | 0.8 |
| `pan` | -1..1 | 0 |

### `pattern`

| Key | Type | Default |
|---|---|---|
| `params` | pattern-section keys | catalog defaults |
| `slot` | 0..7, selected normal slot (web `editSlot`) | 0 |
| `slots` | 8 patterns (P1-P8) | 8 default patterns |
| `drumSlot` | 0..7 | 0 |
| `drums` | 8 drum slots, each `{ "lanes": [D1, D2, D3, D4] }` | factory beat in every slot |
| `berlin` | `{ "enabled", "seeded", "slot", "slots": [8 Berlin patterns] }` | off, not seeded, slot 0, defaults |
| `automation` | `{ "n0".."n7", "b0".."b7": bank }` | `{}` |
| `song` | optional object: the hidden arrange slot (`SONG_SLOT = 8`), kept verbatim, never shown as P9 | absent |

**Pattern** (a normal slot):

| Field | Type | Default |
|---|---|---|
| `steps` | 32 steps | 32 default steps |
| `stepCount` | 1..32 | 8 |
| `division` | **number** steps per bar: 2 / 4 / 8 / 16, or triplets 3 = 1/2T, 6 = 1/4T, 12 = 1/8T, 24 = 1/16T, 48 = 1/32T (strings accepted) | 8 |
| `reverse` | bool | false |
| `enabled` | bool | true |
| `gate` | 0.05..1 | 0.9 |
| `repeat` | 1..8 | 1 |

**Step:**

| Field | Type | Default |
|---|---|---|
| `tune` | integer semitones -39..48 (raw, before scale quantize) | 0 |
| `fine` | integer cents -100..100 (never quantized) | 0 |
| `on` | bool | true (drum lanes: the factory beat, see Defaults) |
| `accent` | bool | false |
| `slide` | bool | false |
| `ratch` | integer 1..4 (the web field name; not `ratchet`) | 1 |
| `chord` | extra intervals: integers, rounded, non-zero, unique, sorted, at most 5 | `[]` |

**Drum lane:** the clock fields of a pattern (`steps`, `stepCount`, `division`, `reverse`, `enabled`, `gate`), no `repeat`.
Drums use `on`, `accent` and `ratch`.

**Berlin pattern:** `{ "lanes": [8 lanes], "oscCount": 1..4 (3), "modCount": 1..4 (1), "repeat": 1..8 (1) }`.
**Berlin lane:** the clock fields plus `destination` and `amount`. Lanes 0-3 (O1-O4) are always
`osc1Pitch`..`osc4Pitch` with amount 1. Lanes 4-7 (M1-M4): `destination` one of `cutoff`, `resonance`, `highpass`, `off`, `noise` (`noise` is Bare Metal only; the web
resets it to the lane default)
(defaults `cutoff`, `resonance`, `highpass`, `off`), `amount` 0..1 (1).
`seeded` is the web's `berlinO1Seeded`: false means the first time Berlin opens, O1 of each slot is copied from P1-P8.

**Automation bank:** `{ "lanes": { "<param key or pitchBend>": { "samples": [128 values] } }, "offsets": { "<key>": number } }`.
One cycle of the pattern (one pass x repeat) is 128 samples. A sample is a number rounded to 4 decimal places, or
`null` for "not recorded". Shorter lists are padded with `null`, longer ones cut (warning). A lane that is all `null`
is dropped; a bank with nothing left is dropped. At most 128 lanes per bank and keys of at most 64 characters; when
there are more, keys are taken in sorted order. Offsets are the knob offset over the curve; 0 offsets are dropped.
Bank keys other than `n0`-`n7`, `b0`-`b7` (for example the song bank `s`) are kept verbatim.

### `session` (project only)

From `flags.json` `session`:

| Key | Type | Default |
|---|---|---|
| `params` | session-section keys | catalog defaults |
| `xy` | `{ "x": key, "y": key }` | `cutoff`, `resonance` |
| `pitchBendRange` | integer 1..48 semitones | 2 |
| `arp`, `arpChord`, `latch`, `microtuneLock` | bool | false |
| `arpOrder` | `up` / `down` / `upDown` / `random` | `up` |
| `arpRange` | integer 1..3 | 1 |
| `transpose` | integer -48..48 (keyboard transpose) | 0 |
| `chordMemory` | `{ "on": bool, "intervals": chord rules }` | off, `[]` |
| `midiBaseNote` | integer 0..127, MIDI note for C4 / pitch 0 | 60 |
| `midiMaps` | `{ key: { "type": "cc", "cc": 0..127, "channel": 0..15 } or { "type": "note", "note": 0..127, "channel": 0..15 } }`, at most 256, sorted-key order when capped | `{}` |
| `tuning` | optional object, Bare Metal: `{ "custom": [{ "id", "name", "degrees": [semitones, may be fractional], "period": 12 }], "scl": text, "kbm": text }`. Bank 0 custom scales live here, in the file | absent |

Not saved by the web: playback position, audio graph, undo history, view mode and panel state, mixer mutes/solos
(`state.mixer`), MIDI device selection, computer keyboard, write-mode arms (full list: `flags.json` `notSaved`).
A project may store per-channel `mute` and `solo` inside `mix`; a missing flag means false.

### `mix` (optional, project only)

Routing for Bare Metal and web v1.0: channels, reorderable insert slots, sends, 4 aux buses, and a master.
Adding this shape does not bump `version`. A `patch` or `pattern` that carries `mix` ignores it (warning
`ignored:mix`) and does not write it back. A non-object `mix` is dropped (warning `invalid:mix`).

v1 codecs keep a `mix` **object verbatim**. They do not fill defaults, clamp numbers, or drop unknown keys
inside it. `examples/project-mix.ingy` is this shape; both codecs round-trip it. The router, not the codec,
applies the defaults and clamps below when it loads the object. Unknown keys stay in the file either way.

```json
{
  "channels": [
    {
      "id": "osc1",
      "inserts": [{ "type": "compressor", "state": { "threshold": -18 } }],
      "sends": [{ "bus": 0, "level": 0.25 }],
      "level": 0.8,
      "pan": -0.4,
      "mute": false,
      "solo": false
    }
  ],
  "buses": [{ "id": "aux1", "inserts": [{ "type": "reverb", "state": {} }], "level": 0.9 }],
  "master": { "inserts": [{ "type": "distortion", "state": { "drive": 0.2 } }], "level": 0.5 }
}
```

| Field | Type | Router default when the key is missing |
|---|---|---|
| `channels` | array of channel objects. Array order is process order | one channel `main` (an explicit `[]` is no channels) |
| `buses` | bus objects, indexes 0..3 | `aux1`..`aux4`, level 1, no inserts. A shorter list is padded. The router plays the first 4; further entries stay in the file |
| `master` | object | level 1, no inserts |
| `id` | string. The router keeps at most 64 characters | `ch1`, `ch2`, ... ; buses `aux1`..`aux4` |
| `inserts` | array. Array order is process order | `[]` |
| `type` | string, `FxUnit::typeId()` | `unknown` |
| `state` | JSON object, `FxUnit::getState()` / `setState()` | `{}` |
| `sends` | `{ "bus": 0..3, "level": 0..1 }` | no send. A `bus` outside 0..3 is ignored by the router. Level clamps to 0..1 |
| `level` | number 0..1, linear gain | 1 |
| `pan` | number -1..1. -1 is hard left, 0 is center, +1 is hard right | 0 |
| `mute`, `solo` | bool | false |

Stock insert `type`s, which agent H builds and the router does not: `chorus`, `ringmod`, `distortion`,
`bitcrusher`, `delay`, `reverb`, `compressor`. Any other `type` is a placeholder that passes audio and keeps
`state`. Do not write `sequins`, `beads`, or `clouds` as a `type` or anywhere else in `mix`.

The router plays at most 16 channels and 8 inserts on a channel, a bus, or the master. Extra entries stay in
the file. On each channel the signal flows: input, insert chain, delay compensation, sends, level, pan, onto
the master. Sends are pre-fader and pre-pan, after that channel's inserts. Each bus sums its sends, then runs
its inserts, then its level, then the master. The master runs its inserts, then its level. Pan is the Web Audio
equal-power `StereoPannerNode` law: `gL = cos((pan+1)/2 * pi/2)`, `gR = sin((pan+1)/2 * pi/2)`. Buses have no
pan; a bus return uses that law at center. Insert latency is `FxUnit::latencySamples()`. The router delays
every shorter channel, and delays the dry master sum by the longest bus-insert latency, so channels and bus
returns line up. Its reported latency is that compensation plus the master-insert latency.

Well-known channel ids match the web mixer strips (`ui/js/mixer.js`). The web does not write this object.
These ids are how a host maps the strips when it does:

| `id` | Web strip | Where the web stores level and pan |
|---|---|---|
| `osc1`..`osc4` | `data-strip="osc"` index 0..3 | `osc-vol-N`, `osc-pan-N` (N = 0..3) |
| `noise` | `data-strip="noise"` | `noiseVol`. The strip has no pan knob; pan stays 0 |
| `d1`..`d4` | `data-strip="drum"` index 0..3 | `voice.flags.drumKit[i].vol` / `.pan` |

`master.level` is not the web `volume` parameter. The web master fader writes `volume` (the engine starts that
gain at 0.5). `mix.master.level` defaults to 1 and is a separate stage.

Mute and solo follow the web when a host applies its arrays: a strip is open when it is not muted, and either
nobody is soloed or this strip is soloed. Solo is shared across osc, noise, and drum strips. The web ramps
that gate over 20 ms. A drum mute or solo array of length 3 is a web quirk from the old 3-lane kits: the
router prepends `false` and then maps the flags onto `d1`..`d4`. The web compressor strip is a processor on
the master path plus a sidechain source, not an aux bus. `compressor` may sit in any insert list. The
sidechain source is not part of `mix`.

### `arrangement` (optional, project only)

The arrange-mode song. Both apps write it on save (`song-save.js`, the same file in each repo) and leave it
out when the song is empty. Loading a `project` replaces the song with this section, or with an empty song when
the section is absent; a `patch` or `pattern` never touches it. Adding this shape does not bump `version`.

Like `mix`, v1 codecs keep the `arrangement` **object verbatim**: no defaults, clamping or key dropping.
`song-save.js` checks it when it builds the song.

```json
"arrangement": {
  "v": 1,
  "synth": { "clips": [ ... ] },
  "drums": { "clips": [ ... ] },
  "lanes": [ { "clips": [ ... ] }, { "clips": [ ... ] }, { "clips": [ ... ] }, { "clips": [ ... ] } ],
  "transpose": [ { "tick": 0, "semi": 0 } ],
  "loop": { "on": false, "startTick": 0, "endTick": 0 }
}
```

`lanes` is optional and written only when it holds a clip: the four Berlin oscillator rows, O1 first, each a
track of its own (`o1`..`o4`).

Ticks are 960 per quarter note; a bar is 3840. Each track's `clips` is a stack, bottom first: clips may
overlap and a later clip covers an earlier one where they overlap. Every clip has `id`, `kind`, `startTick`,
`lengthTick` and an optional `startOffset` (ticks trimmed off the front of its pattern; negative = silence before it).

| `kind` | Track | Extra keys |
|---|---|---|
| `n` | `synth` | `source` (P slot 0-7), `data` (a pattern, same shape as a `pattern.slots` entry), `automation`, `edited`, `copiedHash`, `keptHash` |
| `b` | `synth` | as `n`, with `data` a Berlin pattern and `laneMask` (8 booleans, `false` = lane muted). Files from before the oscillator rows only: on load each becomes one row clip per oscillator the pattern uses |
| `b` | `lanes[row]` | an oscillator row clip: as above, plus `row` (0-3, the same as its place in `lanes`) and optional `mute`. It plays only lane `row` of `data`; the pattern's mod lanes play from the first row, O1 down, that has a clip at that moment. `laneMask` only matters for the mod lanes (indexes 4-7) |
| `d` | `drums` | as `n`, with `data.lanes` the 4 drum lanes and `laneMask` (4 booleans) |
| `notes` | `synth` | `notes`: `{ startTick, durTick, semi, fine, velocity, legato }`, `startTick` relative to the clip's pattern start, `semi` from C4, `fine` in cents, `velocity` 0-1; optional `name` (an imported MIDI file's name) |

Unknown keys on a clip are kept. A clip with an unknown `kind`, on the wrong track, or (`n`/`b`/`d`) without
`data` is dropped on load; a missing or duplicate `id` gets a new one. Undo history and the playhead are not saved.

## Normalizing on load

`parse` = JSON parse -> `migrate` -> `normalize`. The result is the **canonical document**: every known key present,
every value valid.

1. **Missing keys load as defaults.** `null` counts as missing everywhere.
2. **Unknown keys are kept** and written back, at every level that is an object (top level, sections, flags,
   patterns, steps, lanes, drum patches, automation banks and lanes, `xy`, `chordMemory`). Elements past the fixed
   length of a fixed list (more than 8 slots, 32 steps, 4 drum lanes, 8 Berlin lanes, 4 drum patches) are dropped (warning `truncated`).
3. **Numbers** are clamped to range like `clampToCatalog` (no snapping to `step`); integer fields are rounded first
   (JS `Math.round`: halves go up). Numeric strings are accepted. A non-numeric or non-finite value becomes the default
   (warning `invalid`). `-0` is written as `0`.
4. **Booleans** must be JSON `true`/`false`; anything else becomes the default (warning `invalid`).
5. **Selects** must be one of their options (a number is converted to its string first); otherwise the default
   (warning `invalid`). A select with no options (`scaleSelect`) takes any string up to 64 characters.
6. **Wrong container types** (an array where an object belongs, a string where a list belongs) become the default (warning `invalid`).

### Defaults

The default document of each kind is `makeDefault(kind)`; `expected/default-project.full.json` is the full default
project and both codecs must produce it exactly. Defaults that depend on position:

- A missing or `null` step is the default step for its position, and a step's missing fields come from that step.
  Normal and Berlin slots: `{ tune 0, fine 0, on true, accent false, slide false, ratch 1, chord [] }`.
  Drum lane D*n*: the factory beat, 8 steps at 1/8, `on` at 1-indexed steps D1 `[7]`, D2 `[2,4,6,8]`, D3 `[3,7]`, D4 `[1,3,5,7]`, everything else a rest.
- A missing drum patch is the lane's default patch (see the `drumKit` table).

## Minimal form (what writers write)

Because missing keys load as defaults, writers leave defaults out. A full project is about 280 KB of JSON; its
minimal form is usually a few KB, and a link a few hundred characters.

`serialize(doc)` writes `minimize(doc)`:
- Compare against `makeDefault(doc.kind)`. Any value equal to its default is left out.
- Fixed lists of records (slots, steps, drum slots and lanes, Berlin slots and lanes, the drum kit) compare element by
  element. An element equal to its default becomes `null`, and trailing `null`s are removed.
- Other arrays (`chord`, `intervals`, unknown arrays) are values: written whole or not at all.
- Automation `samples` lose their trailing `null`s.
- `format`, `version` and `kind` are always written. An `open_hat` drum patch that is written at all always carries `choke`.

Contract: `normalize(minimize(doc))` deep-equals `doc` with no warnings, for every canonical `doc`.
`test/run.mjs` checks every example plus 300 random documents.

## Serialization

Compact JSON (pretty, 2-space indent, allowed for files), keys sorted in every object, UTF-8, no BOM.
Numbers are the shortest form that round-trips (`JSON.stringify`); integral values have no decimal point.
JS and C++ will not always produce identical text, so **documents are compared by parsed content, never by bytes**.

## Share links

`https://<site>/#p=<payload>`, payload = base64url **without padding** of deflate-raw (RFC 1951, no zlib header) of
the UTF-8 compact minimal serialization, with `voice.speechBank` and `voice.fm6Bank` removed.

- Browser: `CompressionStream('deflate-raw')` (Safari 16.4+), asynchronous. C++: zlib with `windowBits = -15`.
- Decoding: take the `p=` parameter of the fragment (`#p=...&x=...` allowed); accept padding; any other character is
  error `bad-link`; inflate with a **1 MB cap** (error `too-large`); UTF-8 must be valid (`bad-link`); then `parse`.
- A link longer than **2000 characters** is too long: share the file instead (`encodeLink` reports `tooLong`).
- The fragment never reaches a server. Opening a link loads the project after one confirm, showing `name` and `by` as plain text.
- iOS universal links / Android app links open the app when installed (needs `apple-app-site-association` and
  `assetlinks.json` on a real HTTPS domain); otherwise the web app.

## Files

- Extension `.ingy`, MIME `application/vnd.ingysynth+json`, UTI `com.ingysynth.ingy` (conforms to `public.json`).
- Share as `Name.ingy` (name sanitized for file systems). Files carry everything, including `speechBank` and `fm6Bank`.
- Files over 1 MB are refused (`too-large`).

## Errors

`parse` returns `{ ok, error, warnings, doc }`. Error codes: `not-text`, `too-large`, `not-json`, `not-object`,
`not-ingysynth`, `unknown-kind`, `bad-version`, `bad-link`.

## Warnings

`"<code>:<path>"`, sorted. Path = dot-joined keys and indices, e.g. `clamped:pattern.slots.0.steps.3.tune`.

| Code | Meaning |
|---|---|
| `clamped` | number pulled into range; or a `chord` list that changed when cleaned |
| `invalid` | wrong type or unknown option; default used |
| `truncated` | string or list cut to its limit |
| `dropped` | an entry removed (bad MIDI map, automation lane over the cap or with a bad key, non-numeric offset) |
| `misplaced` | known param in the wrong section, dropped |
| `sanitized` | `name` / `by` changed by cleaning |
| `ignored` | a section the kind doesn't carry |
| `missing` | `version` was absent |
| `newer` | `version` is newer than this codec |
| `migrated` | an old version was upgraded |

C++ must produce the same warning list as `expected/*.json` for every example.

## Loading while playing

- **patch:** applied as one batch (all params, then flags) so the sound changes once.
- **pattern:** swaps at the next bar (next cycle start, like a queued P-slot change).
- **project:** stops playback, loads, and waits for play.

Web apply rules: set params with `params.set` so subscribers run, never by writing the Map; write the bank and then
`selectSlot` so the step strip redraws; read steps from pattern data, never the DOM, and flush the step being edited
(`flushDomToPattern`) before capturing.

## Size limits

| Limit | Value |
|---|---|
| decoded file or link | 1 MB |
| link length | 2000 characters |
| `name`, `by` | 64 code points |
| param/lane/map keys | 64 characters |
| automation lanes per bank | 128 |
| MIDI maps | 256 |
| `scaleSelect`, `xy` | 64 characters |

## Fallbacks between apps

See `fallbacks.md`: what the web plays when a file uses Bare Metal-only features.

## Files in this folder

| Path | What |
|---|---|
| `SPEC.md` | this document |
| `ingy.schema.json` | structural JSON Schema for editors (informational; the codec is normative) |
| `params.json` | generated from the web catalog (`node tools/export-params.mjs`) |
| `params-baremetal.json` | Bare Metal-only keys, hand-written |
| `params.md` | generated list of every key by section |
| `flags.json` | settings outside the catalog, with defaults and where the web keeps them |
| `fallbacks.md` | what each app does with features it doesn't have |
| `js/ingy-codec.js` | reference codec |
| `js/params-data.js` | generated JS module of the three JSON files (Safari can't import JSON) |
| `examples/*.ingy` | test inputs (`test/make-examples.mjs` writes the generated ones) |
| `expected/*.json` | `{ ok, error, warnings, doc (minimal form) }` per example, plus `default-project.full.json` |
| `links/*.json` | `{ url, length, tooLong, decoded (minimal form) }` per loadable example |
| `test/run.mjs` | JS checks; `--update` rewrites expected/ and links/ |
