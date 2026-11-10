// Arrange transport tempo and metronome, laid out like Ableton's control bar:
// TAP, a BPM field (drag up/down, arrows, wheel, double-click or type to edit)
// and a metronome toggle that clicks while the arrangement plays.

import { state } from './state.js?v=120';
import { getNumber, set, subscribe } from './params.js?v=44';
import { songBeatsBetween } from './song-conductor.js?v=32';

const TEMPO_MIN = 20;
const TEMPO_MAX = 240;
const DRAG_PX_PER_BPM = 3;
const TAP_RESET_MS = 2000;
const TAP_KEEP = 4;
const METRO_KEY = 'ingysynth.metronome';
const LOOKAHEAD_SEC = 0.12;
const PUMP_MS = 25;

const native = !!window.__JUCE__?.backend;

let metronomeOn = false;
let taps = [];
/** Audio time the web click scheduler has covered, or null when it starts fresh. */
let clickedUntil = null;
let pumpTimer = 0;

export function arrangeTempoMarkup() {
    return `
            <div class="arrange-tempo" role="group" aria-label="Tempo">
                <button type="button" id="arrangeTap" class="arrange-btn arrange-tap" title="Tap tempo">TAP</button>
                <div id="arrangeBpm" class="arrange-bpm" role="spinbutton" tabindex="0"
                    aria-label="Tempo" aria-valuemin="${TEMPO_MIN}" aria-valuemax="${TEMPO_MAX}"
                    title="Drag up or down, or double-click to type"><span id="arrangeBpmValue">120</span></div>
                <button type="button" id="arrangeMetronome" class="arrange-btn arrange-btn-icon arrange-metronome"
                    aria-pressed="false" aria-label="Metronome" title="Metronome"><span class="arrange-icon-metro" aria-hidden="true"><i></i><i></i></span></button>
            </div>`;
}

function clampTempo(n) {
    return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, Math.round(n)));
}

function tempoNow() {
    const n = getNumber('tempo', 120);
    return Number.isFinite(n) && n > 0 ? n : 120;
}

function setTempo(n) {
    if (!Number.isFinite(n)) return;
    set('tempo', clampTempo(n));
}

function paintTempo() {
    const field = document.getElementById('arrangeBpm');
    const value = document.getElementById('arrangeBpmValue');
    if (!field || !value) return;
    const t = Math.round(tempoNow());
    if (!field.classList.contains('is-editing')) value.textContent = String(t);
    field.setAttribute('aria-valuenow', String(t));
    field.setAttribute('aria-valuetext', `${t} BPM`);
}

function paintMetronome() {
    const btn = document.getElementById('arrangeMetronome');
    if (!btn) return;
    btn.setAttribute('aria-pressed', metronomeOn ? 'true' : 'false');
    btn.classList.toggle('is-on', metronomeOn);
}

function onTap() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > TAP_RESET_MS) taps = [];
    taps.push(now);
    if (taps.length > TAP_KEEP) taps.shift();
    if (taps.length < 2) return;
    const span = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    if (span > 0) setTempo(60000 / span);
}

function beginEdit(seed) {
    const field = document.getElementById('arrangeBpm');
    if (!field || field.classList.contains('is-editing')) return;
    field.classList.add('is-editing');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.className = 'arrange-bpm-input';
    input.setAttribute('aria-label', 'Tempo in BPM');
    input.value = seed ?? String(Math.round(tempoNow()));
    field.replaceChildren(input);
    input.focus();
    if (seed == null) input.select();
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit) setTempo(parseFloat(input.value));
        field.classList.remove('is-editing');
        const span = document.createElement('span');
        span.id = 'arrangeBpmValue';
        field.replaceChildren(span);
        paintTempo();
        field.focus();
    };
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

function bindField(field) {
    let drag = null;
    field.addEventListener('pointerdown', (event) => {
        if (field.classList.contains('is-editing') || event.button !== 0) return;
        event.preventDefault();
        field.focus();
        drag = { id: event.pointerId, y: event.clientY, start: tempoNow(), moved: false };
        try { field.setPointerCapture(event.pointerId); } catch (_) { /* pointer already gone */ }
    });
    field.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const dy = drag.y - event.clientY;
        if (!drag.moved && Math.abs(dy) < 2) return;
        drag.moved = true;
        field.classList.add('is-dragging');
        setTempo(drag.start + dy / DRAG_PX_PER_BPM);
    });
    const endDrag = (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        drag = null;
        field.classList.remove('is-dragging');
    };
    field.addEventListener('pointerup', endDrag);
    field.addEventListener('pointercancel', endDrag);
    field.addEventListener('dblclick', () => beginEdit());
    field.addEventListener('wheel', (event) => {
        if (field.classList.contains('is-editing')) return;
        event.preventDefault();
        setTempo(tempoNow() + (event.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    field.addEventListener('keydown', (event) => {
        if (field.classList.contains('is-editing')) return;
        const step = event.shiftKey ? 10 : 1;
        let handled = true;
        if (event.key === 'ArrowUp') setTempo(tempoNow() + step);
        else if (event.key === 'ArrowDown') setTempo(tempoNow() - step);
        else if (event.key === 'Enter') beginEdit();
        else if (/^[0-9]$/.test(event.key)) beginEdit(event.key);
        else handled = false;
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
}

function setMetronome(on) {
    metronomeOn = !!on;
    try { localStorage.setItem(METRO_KEY, metronomeOn ? '1' : '0'); } catch (_) { /* private mode */ }
    paintMetronome();
    if (native) {
        window.ingySetMetronome?.(metronomeOn);
        return;
    }
    // Toggled on mid-song: click from now, not the beats already heard.
    clickedUntil = songRunning() ? state.audioContext.currentTime : null;
    syncPump();
}

function clickAt(when, bar) {
    const ctx = state.audioContext;
    if (!ctx || !state.masterGain) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(bar ? 1760 : 1320, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.18, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    osc.connect(gain);
    gain.connect(state.masterGain);
    osc.start(when);
    osc.stop(when + 0.06);
}

function songRunning() {
    return !!state.songPlaying && !!state.isPlaying && !!state.audioContext;
}

function pump() {
    if (!metronomeOn || !songRunning()) {
        clickedUntil = null;
        return;
    }
    const now = state.audioContext.currentTime;
    const from = clickedUntil == null ? -Infinity : clickedUntil;
    const { beats, until } = songBeatsBetween(from, now + LOOKAHEAD_SEC);
    for (const beat of beats) {
        // The start beat can sit a few ms behind currentTime; anything older was already heard.
        if (beat.time >= now - 0.03) clickAt(Math.max(now, beat.time), beat.bar);
    }
    if (until != null) clickedUntil = until;
}

// Runs whenever the web metronome is on; pump() idles until the arrangement plays.
function syncPump() {
    const want = !native && metronomeOn;
    if (want && !pumpTimer) {
        pumpTimer = setInterval(pump, PUMP_MS);
        pump();
    } else if (!want && pumpTimer) {
        clearInterval(pumpTimer);
        pumpTimer = 0;
        clickedUntil = null;
    }
}

export function initArrangeTempo() {
    const field = document.getElementById('arrangeBpm');
    if (!field) return;
    try { metronomeOn = localStorage.getItem(METRO_KEY) === '1'; } catch (_) { metronomeOn = false; }
    document.getElementById('arrangeTap').addEventListener('click', onTap);
    document.getElementById('arrangeMetronome').addEventListener('click', () => setMetronome(!metronomeOn));
    bindField(field);
    subscribe('tempo', paintTempo);
    paintTempo();
    paintMetronome();
    if (native) window.ingySetMetronome?.(metronomeOn);
    else syncPump();
}
