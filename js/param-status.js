// Persistent corner dots: magenta (automation, top-left), cyan (MIDI map,
// top-right), phosphor (Berlin Dream-960 destination, bottom-right).

import { state } from './state.js?v=104';

/** @type {(key: string) => boolean} */
let hasAutomationLaneFn = () => false;
/** @type {() => string[]} */
let automationKeysFn = () => [];

const trackedKeys = new Set();

export function bindAutomationStatusSource(hasLane, listKeys) {
    hasAutomationLaneFn = typeof hasLane === 'function' ? hasLane : () => false;
    automationKeysFn = typeof listKeys === 'function' ? listKeys : () => [];
}

function addHost(list, el) {
    if (el && el instanceof Element && !list.includes(el)) list.push(el);
}

function hostFromMappedElement(el) {
    if (!el || !(el instanceof Element)) return null;
    return el.closest?.(
        '.synth-knob, .control, .keyboard-pitch-bend, .keyboard-lfo-strip, .keyboard-master-tune, .pushable'
    ) || el;
}

/** Keyboard + main-panel hosts for a param / mapping key. */
function hostsForKey(key) {
    const hosts = [];
    if (!key) return hosts;

    if (key === 'pitchBend') {
        addHost(hosts, document.getElementById('keyboardPitchBend'));
        return hosts;
    }

    if (key === 'masterTune') {
        document.querySelectorAll('.keyboard-master-tune').forEach((el) => addHost(hosts, el));
        addHost(hosts, document.getElementById('masterTune')?.closest('.control'));
    }

    // Acid strip + filter strip + Ingy6 can all share a data-param — paint every
    // host. querySelector alone sticks the magenta/cyan/Berlin dots on the Acid
    // knob, which Berlin mode hides, so the indicators look "missing".
    document.querySelectorAll(
        `.synth-knob[data-param="${key}"], .ingy6-fader[data-param="${key}"]`
    ).forEach((el) => addHost(hosts, el));

    if (key.startsWith('osc-vol-')) {
        const n = parseInt(key.slice(8), 10) + 1;
        addHost(hosts, document.querySelector(`#kbOsc${n}VolKnob`)?.closest('.synth-knob'));
        document.querySelectorAll(`.osc-vol[data-osc="${key.slice(8)}"]`).forEach((el) => {
            addHost(hosts, el.closest('.control') || el);
        });
    } else if (key.startsWith('osc-tune-')) {
        const n = parseInt(key.slice(9), 10) + 1;
        addHost(hosts, document.querySelector(`#kbOsc${n}TuneKnob`)?.closest('.synth-knob'));
        document.querySelectorAll(`.osc-tune[data-osc="${key.slice(9)}"]`).forEach((el) => {
            addHost(hosts, el.closest('.control') || el);
        });
    } else if (key.startsWith('osc-toggle-')) {
        const osc = key.slice(11);
        document.querySelectorAll(`.osc-toggle[data-osc="${osc}"]`).forEach((el) => {
            addHost(hosts, el.closest('.control') || el);
        });
    } else {
        const byId = document.getElementById(key);
        if (byId) {
            addHost(hosts, byId.closest('.control') || byId.closest('.synth-knob') || byId);
        }
    }

    const mapping = state.midiMappings?.[key];
    if (mapping?.element) {
        addHost(hosts, hostFromMappedElement(mapping.element));
    }

    return hosts;
}

function ensureDots(host) {
    if (!host) return;
    host.classList.add('param-status-host');
    if (!host.querySelector(':scope > .param-status-dot--auto')) {
        const auto = document.createElement('span');
        auto.className = 'param-status-dot param-status-dot--auto';
        auto.setAttribute('aria-hidden', 'true');
        host.appendChild(auto);
    }
    if (!host.querySelector(':scope > .param-status-dot--midi')) {
        const midi = document.createElement('span');
        midi.className = 'param-status-dot param-status-dot--midi';
        midi.setAttribute('aria-hidden', 'true');
        host.appendChild(midi);
    }
}

function applyKey(key) {
    if (!key) return;
    const hasAuto = !!hasAutomationLaneFn(key);
    const hasMidi = !!(state.midiMappings && state.midiMappings[key]);
    if (hasAuto || hasMidi) trackedKeys.add(key);

    hostsForKey(key).forEach((host) => {
        ensureDots(host);
        host.classList.toggle('has-automation', hasAuto);
        host.classList.toggle('has-midi', hasMidi);
    });
}

/**
 * Refresh status dots for one key, or all tracked / known keys.
 * @param {string} [key]
 */
export function refreshParamStatusIndicators(key) {
    if (key != null) {
        applyKey(key);
        return;
    }
    const keys = new Set([
        ...trackedKeys,
        ...automationKeysFn(),
        ...Object.keys(state.midiMappings || {}),
    ]);
    keys.forEach(applyKey);
}

/** Hosts currently carrying Berlin dots, so a re-render can clear them first. */
const berlinHosts = new Set();

/**
 * Paint bottom-right destination dots.
 * @param {Record<string, string[]>} map param key → phosphor colors (one per row)
 */
export function setBerlinDots(map) {
    berlinHosts.forEach((host) => {
        host.querySelectorAll(':scope > .param-status-dot--berlin').forEach((el) => el.remove());
        host.classList.remove('has-berlin');
    });
    berlinHosts.clear();

    Object.entries(map || {}).forEach(([key, colors]) => {
        if (!colors?.length) return;
        hostsForKey(key).forEach((host) => {
            ensureDots(host);
            colors.forEach((color, i) => {
                const dot = document.createElement('span');
                dot.className = 'param-status-dot param-status-dot--berlin';
                dot.setAttribute('aria-hidden', 'true');
                dot.style.background = color;
                dot.style.boxShadow = `0 0 5px ${color}`;
                dot.style.right = `${2 + i * 9}px`;
                host.appendChild(dot);
            });
            host.classList.add('has-berlin');
            berlinHosts.add(host);
        });
    });
}

export function initParamStatus() {
    refreshParamStatusIndicators();
}
