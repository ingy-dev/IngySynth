// Shared site header. Transport buttons exist only on the synth page.
// Master mute holds the output at 0 without writing the volume parameter.

import { state } from './state.js?v=120';
import { togglePlay } from './sequencer.js?v=436';
import { getNumber, subscribe } from './params.js?v=24';
import { setArrangeView } from './arrange-view.js?v=6';

function writeMasterGain(level, ramp) {
    const gain = state.masterGain;
    const ctx = state.audioContext;
    if (!gain || !ctx) return;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    if (!ramp) {
        gain.gain.setValueAtTime(level, now);
        return;
    }
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(level, now + 0.02);
}

function applyMasterMute() {
    const level = state.masterMuted ? 0 : getNumber('volume', 0.5);
    writeMasterGain(level, true);
}

function syncPlayButton(playing) {
    const button = document.getElementById('sitePlay');
    if (!button) return;
    button.classList.toggle('start', !playing);
    button.classList.toggle('stop', playing);
    button.setAttribute('aria-pressed', playing ? 'true' : 'false');
    button.setAttribute('aria-label', playing ? 'Stop sequencer' : 'Start sequencer');
}

function syncMuteButton() {
    const button = document.getElementById('siteMute');
    if (!button) return;
    const muted = !!state.masterMuted;
    button.classList.toggle('is-muted', muted);
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

function setMenuOpen(open) {
    const bar = document.querySelector('.site-bar');
    const menu = document.getElementById('siteMenu');
    const nav = document.getElementById('siteNav');
    if (!bar || !menu || !nav) return;
    bar.classList.toggle('is-menu-open', open);
    menu.setAttribute('aria-expanded', open ? 'true' : 'false');
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    nav.hidden = !open;
    if (open) {
        nav.querySelector('a')?.focus();
    }
}

export function initSiteBar() {
    state.masterMuted = false;

    const play = document.getElementById('sitePlay');
    const mute = document.getElementById('siteMute');
    const menu = document.getElementById('siteMenu');
    const nav = document.getElementById('siteNav');
    const bar = document.querySelector('.site-bar');

    play?.addEventListener('click', () => {
        togglePlay();
    });
    document.addEventListener('ingysynth:sequencer-start', () => syncPlayButton(true));
    document.addEventListener('ingysynth:sequencer-stop', () => syncPlayButton(false));

    mute?.addEventListener('click', () => {
        state.masterMuted = !state.masterMuted;
        applyMasterMute();
        syncMuteButton();
    });

    // Volume changes rewrite masterGain. Keep a mute in place without moving the knob.
    subscribe('volume', () => {
        if (state.masterMuted) writeMasterGain(0, false);
    });

    // initAudio sets masterGain to the volume on the gesture that creates the
    // context. Re-apply mute after that listener (registered earlier, capture).
    const reapplyMute = () => {
        if (state.masterMuted) writeMasterGain(0, false);
    };
    document.addEventListener('click', reapplyMute, true);
    document.addEventListener('keydown', reapplyMute, true);

    menu?.addEventListener('click', () => {
        const open = menu.getAttribute('aria-expanded') !== 'true';
        setMenuOpen(open);
    });

    document.getElementById('siteViewPerform')?.addEventListener('click', () => {
        setArrangeView(false);
    });
    document.getElementById('siteViewArrange')?.addEventListener('click', () => {
        setArrangeView(true);
    });

    nav?.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : event.target.parentElement;
        const link = target?.closest('a');
        if (!link) return;
        if (link.getAttribute('href') === '#arrange') {
            event.preventDefault();
            setArrangeView(true);
        } else if (link.getAttribute('aria-current') === 'page') {
            event.preventDefault();
        }
        setMenuOpen(false);
        menu?.focus();
    });

    document.addEventListener('pointerdown', (event) => {
        if (!bar || nav?.hidden) return;
        if (bar.contains(event.target)) return;
        setMenuOpen(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || nav?.hidden) return;
        setMenuOpen(false);
        menu?.focus();
    });

    initNoteHeader();
}

// Phone portrait and short landscape: the note sits outside Scale / Tuning,
// above the mode switches, and stays there on every tab. Desktop keeps the
// main copy in the fieldset until that section is collapsed or tab-hidden.
// "In header" lifts that note under the logo. Landscape and desktop also lift
// semitone (left) and octave (right). Portrait keeps only the return glyph.
const NOTE_DOCK_MQ = '(max-width: 768px), (hover: none) and (pointer: coarse) and (orientation: landscape) and (max-height: 500px)';
const NOTE_HEADER_COMPACT_MQ = '(orientation: portrait) and (max-width: 768px)';
const NOTE_HEADER_KEY = 'ingysynth.noteInHeader';

function initNoteHeader() {
    const patternPair = document.getElementById('kbPatternNotePair');
    const xyPair = document.getElementById('kbXyNotePair');
    const patternDock = document.getElementById('kbPatternNoteDock');
    const xyDock = document.getElementById('kbXyNoteDock');
    const patternHome = document.querySelector('#keyboardTuningFieldset .keyboard-tuning-center');
    const noteBar = document.getElementById('siteNoteBar');
    const noteCenter = document.getElementById('siteNoteCenter');
    const noteSemi = document.getElementById('siteNoteSemi');
    const noteOct = document.getElementById('siteNoteOct');
    const octave = document.querySelector('#keyboardTuningFieldset .keyboard-pattern-octave');
    const semi = document.querySelector('#keyboardTuningFieldset .keyboard-tuning-semi');
    const octaveHome = octave?.parentElement || null;
    const semiHome = semi?.parentElement || null;
    const buttons = Array.from(document.querySelectorAll('.note-vfd-float'));
    if (!patternPair || !noteBar || !noteCenter) return;

    let floated = false;
    try {
        floated = localStorage.getItem(NOTE_HEADER_KEY) === '1';
    } catch (_) { /* private mode */ }

    function park(node, parent) {
        if (node && parent && node.parentElement !== parent) parent.appendChild(node);
    }

    function syncNoteHeader() {
        const compact = window.matchMedia(NOTE_HEADER_COMPACT_MQ).matches;
        document.body.classList.toggle('note-in-header', floated);
        noteBar.hidden = !floated;
        buttons.forEach((button) => {
            button.setAttribute('aria-pressed', floated ? 'true' : 'false');
            button.setAttribute('aria-label', floated ? 'Return note to panel' : 'Show note in header');
        });
        if (floated) {
            park(patternPair, noteCenter);
            if (compact) {
                park(semi, semiHome);
                park(octave, octaveHome);
            } else {
                park(semi, noteSemi);
                park(octave, noteOct);
            }
        } else {
            const fieldset = document.getElementById('keyboardTuningFieldset');
            const homeHidden = !fieldset
                || fieldset.classList.contains('collapsed')
                || fieldset.classList.contains('kb-tab-hidden');
            const mobileDock = window.matchMedia(NOTE_DOCK_MQ).matches;
            park(patternPair, (mobileDock || homeHidden) ? patternDock : patternHome);
            park(semi, semiHome);
            park(octave, octaveHome);
        }
        park(xyPair, xyDock);
    }

    // A real tap presses the button, then clicks it. Rotation can deliver an
    // extra click on the focused pin (or on the node after it moves into the
    // header) and clear a pin that was already set. Ignore that click.
    let pressedButton = null;
    let floatedAtPress = null;
    let pressStamp = 0;
    let suppressClicksUntil = 0;

    function rememberPin() {
        try {
            localStorage.setItem(NOTE_HEADER_KEY, floated ? '1' : '0');
        } catch (_) { /* private mode */ }
    }

    function clearPress() {
        pressedButton = null;
        floatedAtPress = null;
        pressStamp = 0;
    }

    buttons.forEach((button) => {
        button.addEventListener('pointerdown', () => {
            pressedButton = button;
            floatedAtPress = floated;
            pressStamp = performance.now();
        });
        button.addEventListener('pointercancel', () => {
            if (pressedButton === button) clearPress();
        });
        button.addEventListener('click', (event) => {
            const fresh = pressedButton === button && performance.now() - pressStamp < 700;
            clearPress();
            const keyboard = event.detail === 0;
            if (performance.now() < suppressClicksUntil || (!fresh && !keyboard)) {
                syncNoteHeader();
                return;
            }
            floated = !floated;
            rememberPin();
            syncNoteHeader();
        });
    });

    function onOrientationFlip() {
        // Hold the pin that was already set. A click that lands during the
        // turn, including one that already ran, must not write the opposite value.
        const keep = (pressedButton && (floatedAtPress === true || floatedAtPress === false))
            ? floatedAtPress
            : floated;
        suppressClicksUntil = performance.now() + 800;
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('note-vfd-float')) {
            active.blur();
        }
        const reapply = () => {
            floated = keep;
            clearPress();
            rememberPin();
            syncNoteHeader();
        };
        reapply();
        setTimeout(reapply, 50);
        setTimeout(reapply, 400);
    }

    let landscape = window.matchMedia('(orientation: landscape)').matches;
    const onViewport = () => {
        const next = window.matchMedia('(orientation: landscape)').matches;
        if (next === landscape) {
            syncNoteHeader();
            return;
        }
        landscape = next;
        onOrientationFlip();
    };

    const queries = [NOTE_DOCK_MQ, NOTE_HEADER_COMPACT_MQ, '(orientation: landscape)'];
    queries.forEach((query) => {
        const mq = window.matchMedia(query);
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onViewport);
        else mq.addListener(onViewport);
    });
    window.addEventListener('orientationchange', onOrientationFlip);

    const tuningFieldset = document.getElementById('keyboardTuningFieldset');
    if (tuningFieldset) {
        new MutationObserver(syncNoteHeader).observe(tuningFieldset, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    syncNoteHeader();
}
