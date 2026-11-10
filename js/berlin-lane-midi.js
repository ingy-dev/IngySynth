// MIDI out channel for each Berlin O lane. 0 = the lane follows the
// main MIDI channel; 1..16 = its own. It is a setup choice, not pattern data: it holds
// across patterns and projects and is kept between launches.
// Imports nothing, so berlin.js and whatever sends the MIDI (the web sequencer.js,
// Bare Metal's juce-bridge.js) can both load it without a cycle.

const STORE_KEY = 'ingysynth.berlinLaneMidi';
const LANES = 4;

const channels = load();

function clean(value) {
    const n = Math.round(Number(value));
    return n >= 1 && n <= 16 ? n : 0;
}

function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { /* no storage */ }
    return Array.from({ length: LANES }, (_, lane) => clean(Array.isArray(saved) ? saved[lane] : 0));
}

/** Channels for O1..O4: 0 (main) or 1..16. */
export function berlinLaneMidiChannels() {
    return channels.slice();
}

export function setBerlinLaneMidiChannel(lane, channel) {
    if (!(lane >= 0 && lane < LANES)) return;
    const next = clean(channel);
    if (channels[lane] === next) return;
    channels[lane] = next;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(channels)); } catch (_) { /* no storage */ }
    document.dispatchEvent(new CustomEvent('ingysynth:berlin-lane-midi', { detail: { channels: channels.slice() } }));
}
