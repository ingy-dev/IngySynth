// Mixer: level / pan / mute / solo / master on persistent buses.
// Vertical channel strips; linear 0–100 scale + ticks match fader travel. INGY6 faders untouched.

import { state, OSC_COUNT } from './state.js?v=120';
import { getNumber, getOscVol, getOscPan, set, subscribe } from './params.js?v=44';
import { applyMixerMutes } from './store-engine.js?v=88';
import { applyBerlinDrumKitToLive } from './osc-source.js?v=157';
import { DRUM_LANE_COUNT, ensureBerlinDrumKit } from './pattern-bank.js?v=50';

const MIXER_SCALE = ['100', '80', '60', '40', '20', '0'];

let mixerFaderDragDepth = 0;

function fitDrumFlags(arr) {
    if (!Array.isArray(arr)) return Array.from({ length: DRUM_LANE_COUNT }, () => false);
    if (arr.length === 3) return [false, arr[0], arr[1], arr[2]];
    const out = arr.slice(0, DRUM_LANE_COUNT);
    while (out.length < DRUM_LANE_COUNT) out.push(false);
    return out;
}

function ensureMixer() {
    if (!state.mixer) {
        state.mixer = {
            oscMute: [false, false, false, false],
            oscSolo: [false, false, false, false],
            noiseMute: false,
            noiseSolo: false,
            drumMute: Array.from({ length: DRUM_LANE_COUNT }, () => false),
            drumSolo: Array.from({ length: DRUM_LANE_COUNT }, () => false),
        };
    }
    state.mixer.drumMute = fitDrumFlags(state.mixer.drumMute);
    state.mixer.drumSolo = fitDrumFlags(state.mixer.drumSolo);
    return state.mixer;
}

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

function formatPan(n) {
    const v = Math.round((Number(n) || 0) * 50);
    if (v === 0) return 'C';
    return v < 0 ? `L${Math.abs(v)}` : `R${v}`;
}

function formatLevel(n) {
    return String(Math.round(clamp(Number(n) || 0, 0, 1) * 100));
}

function syncLevelReadout(row, value) {
    const el = row.querySelector('.mixer-level-value');
    if (el) el.textContent = formatLevel(value);
}

function applyDrumStrip(lane, partial) {
    const kit = ensureBerlinDrumKit();
    const patch = kit[lane];
    if (!patch) return;
    if (partial.vol != null) patch.vol = Math.max(0, Math.min(1, partial.vol));
    if (partial.pan != null) patch.pan = Math.max(-1, Math.min(1, partial.pan));
    applyBerlinDrumKitToLive(lane);
    const now = state.audioContext?.currentTime ?? 0;
    try {
        state.berlinDrumPanners?.[lane]?.pan.setValueAtTime(patch.pan, now);
    } catch (_) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('ingysynth:drum-kit', { detail: { lane } }));
}

function syncStripButtons(row, muteOn, soloOn) {
    const mute = row.querySelector('.mixer-mute');
    const solo = row.querySelector('.mixer-solo');
    if (mute) {
        mute.classList.toggle('off', !muteOn);
        mute.setAttribute('aria-pressed', muteOn ? 'true' : 'false');
    }
    if (solo) {
        solo.classList.toggle('off', !soloOn);
        solo.setAttribute('aria-pressed', soloOn ? 'true' : 'false');
    }
}

function notifyMixerMutes() {
    document.dispatchEvent(new CustomEvent('ingysynth:mixer-mutes'));
}

/** Toggle D-lane mute (shared with mixer strip). */
export function toggleDrumMute(lane) {
    const mix = ensureMixer();
    const i = Math.max(0, Math.min(DRUM_LANE_COUNT - 1, lane | 0));
    mix.drumMute[i] = !mix.drumMute[i];
    applyMixerMutes();
    refreshMixerUi();
}

/** Toggle D-lane solo (shared with mixer strip; additive with other solos). */
export function toggleDrumSolo(lane) {
    const mix = ensureMixer();
    const i = Math.max(0, Math.min(DRUM_LANE_COUNT - 1, lane | 0));
    mix.drumSolo[i] = !mix.drumSolo[i];
    applyMixerMutes();
    refreshMixerUi();
}

function syncFaderCap(slot) {
    const input = slot.querySelector('.mixer-level');
    const cap = slot.querySelector('.mixer-fader-cap');
    if (!input || !cap) return;
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 1;
    const value = parseFloat(input.value);
    const span = hi - lo || 1;
    const pct = clamp(((Number.isFinite(value) ? value : lo) - lo) / span, 0, 1);
    const travel = Math.max(0, slot.clientHeight - cap.offsetHeight);
    cap.style.top = `${(1 - pct) * travel}px`;
}

export function syncMixerFaderCaps() {
    document.querySelectorAll('#keyboardMixerPanel .mixer-fader-slot').forEach(syncFaderCap);
}

function faderValueFromClientY(slot, input, clientY) {
    const rect = slot.getBoundingClientRect();
    const cap = slot.querySelector('.mixer-fader-cap');
    const capH = cap?.offsetHeight || 32;
    const travel = Math.max(1, rect.height - capH);
    const y = clientY - rect.top - capH / 2;
    const pct = clamp(1 - y / travel, 0, 1);
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 1;
    const stepRaw = parseFloat(input.step);
    const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 0.01;
    const raw = lo + pct * (hi - lo);
    const stepped = Math.round(raw / step) * step;
    return clamp(Number(stepped.toFixed(4)), lo, hi);
}

function wireFaderPointer(slot) {
    const input = slot.querySelector('.mixer-level');
    if (!input || input.dataset.mixerPtrBound) return;
    input.dataset.mixerPtrBound = '1';

    const applyFromEvent = (e) => {
        if (input.disabled) return;
        const clientY = e.clientY;
        if (!Number.isFinite(clientY)) return;
        const next = faderValueFromClientY(slot, input, clientY);
        if (Number(input.value) === next) {
            syncFaderCap(slot);
            return;
        }
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const onPointerDown = (e) => {
        if (input.disabled) return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        mixerFaderDragDepth += 1;
        try {
            slot.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        applyFromEvent(e);
    };

    const onPointerMove = (e) => {
        if (mixerFaderDragDepth <= 0) return;
        if (!slot.hasPointerCapture?.(e.pointerId) && e.buttons === 0) return;
        e.preventDefault();
        applyFromEvent(e);
    };

    const endDrag = (e) => {
        if (mixerFaderDragDepth <= 0) return;
        mixerFaderDragDepth = Math.max(0, mixerFaderDragDepth - 1);
        try {
            if (e?.pointerId != null) slot.releasePointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
    };

    slot.addEventListener('pointerdown', onPointerDown);
    slot.addEventListener('pointermove', onPointerMove);
    slot.addEventListener('pointerup', endDrag);
    slot.addEventListener('pointercancel', endDrag);
    input.addEventListener('input', () => syncFaderCap(slot));
}

function ensureFaderChrome(panel) {
    panel.querySelectorAll('.mixer-fader').forEach((fader) => {
        if (!fader.querySelector('.mixer-fader-scale')) {
            const scale = document.createElement('div');
            scale.className = 'mixer-fader-scale';
            scale.setAttribute('aria-hidden', 'true');
            MIXER_SCALE.forEach((label) => {
                const span = document.createElement('span');
                span.textContent = label;
                scale.appendChild(span);
            });
            fader.appendChild(scale);
        }
        const slot = fader.querySelector('.mixer-fader-slot');
        if (!slot) return;
        slot.querySelector('.mixer-fader-ticks')?.remove();
        if (!fader.querySelector(':scope > .mixer-fader-ticks')) {
            const ticks = document.createElement('div');
            ticks.className = 'mixer-fader-ticks';
            ticks.setAttribute('aria-hidden', 'true');
            const majors = MIXER_SCALE.length;
            const total = majors + (majors - 1);
            for (let i = 0; i < total; i++) {
                const tick = document.createElement('span');
                tick.className = 'mixer-fader-tick';
                if (i % 2 === 0) tick.classList.add('mixer-fader-tick--major');
                ticks.appendChild(tick);
            }
            fader.insertBefore(ticks, slot);
        }
        if (!slot.querySelector('.mixer-fader-track')) {
            const track = document.createElement('div');
            track.className = 'mixer-fader-track';
            track.setAttribute('aria-hidden', 'true');
            slot.insertBefore(track, slot.firstChild);
        }
        if (!slot.querySelector('.mixer-fader-cap')) {
            const cap = document.createElement('div');
            cap.className = 'mixer-fader-cap';
            cap.setAttribute('aria-hidden', 'true');
            const track = slot.querySelector('.mixer-fader-track');
            slot.insertBefore(cap, track ? track.nextSibling : slot.firstChild);
        }
        wireFaderPointer(slot);
        syncFaderCap(slot);
        const strip = fader.closest('.mixer-strip');
        if (strip && !strip.querySelector(':scope > .mixer-level-value')) {
            const readout = document.createElement('span');
            readout.className = 'mixer-level-value';
            readout.setAttribute('aria-hidden', 'true');
            fader.after(readout);
        }
    });
}

export function refreshMixerUi() {
    const mix = ensureMixer();
    const root = document.getElementById('keyboardMixerPanel');
    if (!root) return;
    root.querySelectorAll('.mixer-strip[data-strip]').forEach((row) => {
        const kind = row.dataset.strip;
        if (kind === 'osc') {
            const i = parseInt(row.dataset.index, 10);
            const vol = row.querySelector('.mixer-level');
            const pan = row.querySelector('.mixer-pan');
            const panVal = row.querySelector('.mixer-pan-value');
            if (vol) vol.value = String(getOscVol(i));
            if (pan) pan.value = String(getOscPan(i));
            if (panVal) panVal.textContent = formatPan(getOscPan(i));
            syncStripButtons(row, !!mix.oscMute[i], !!mix.oscSolo[i]);
        } else if (kind === 'noise') {
            const vol = row.querySelector('.mixer-level');
            if (vol) vol.value = String(getNumber('noiseVol', 0));
            syncStripButtons(row, !!mix.noiseMute, !!mix.noiseSolo);
        } else if (kind === 'drum') {
            const i = parseInt(row.dataset.index, 10);
            const patch = state.berlinDrum?.[i];
            const vol = row.querySelector('.mixer-level');
            const pan = row.querySelector('.mixer-pan');
            const panVal = row.querySelector('.mixer-pan-value');
            if (vol) vol.value = String(patch?.vol ?? 0.8);
            if (pan) pan.value = String(patch?.pan ?? 0);
            if (panVal) panVal.textContent = formatPan(patch?.pan ?? 0);
            syncStripButtons(row, !!mix.drumMute[i], !!mix.drumSolo[i]);
        } else if (kind === 'master') {
            const vol = row.querySelector('.mixer-level');
            if (vol) vol.value = String(getNumber('volume', 0.5));
        }
        const slot = row.querySelector('.mixer-fader-slot');
        if (slot) syncFaderCap(slot);
        const vol = row.querySelector('.mixer-level');
        if (vol) syncLevelReadout(row, vol.value);
    });
    notifyMixerMutes();
}

function wireStrip(row) {
    const kind = row.dataset.strip;
    const index = parseInt(row.dataset.index, 10);
    const mix = ensureMixer();
    const vol = row.querySelector('.mixer-level');
    const pan = row.querySelector('.mixer-pan');
    const panVal = row.querySelector('.mixer-pan-value');
    const mute = row.querySelector('.mixer-mute');
    const solo = row.querySelector('.mixer-solo');

    vol?.addEventListener('input', () => {
        const v = parseFloat(vol.value);
        syncLevelReadout(row, v);
        if (kind === 'osc') set(`osc-vol-${index}`, v);
        else if (kind === 'noise') set('noiseVol', v);
        else if (kind === 'drum') applyDrumStrip(index, { vol: v });
        else if (kind === 'master') set('volume', v);
    });
    pan?.addEventListener('input', () => {
        const v = parseFloat(pan.value);
        if (panVal) panVal.textContent = formatPan(v);
        if (kind === 'osc') set(`osc-pan-${index}`, v);
        else if (kind === 'drum') applyDrumStrip(index, { pan: v });
    });
    mute?.addEventListener('click', () => {
        if (kind === 'drum') {
            toggleDrumMute(index);
            return;
        }
        if (kind === 'osc') mix.oscMute[index] = !mix.oscMute[index];
        else if (kind === 'noise') mix.noiseMute = !mix.noiseMute;
        applyMixerMutes();
        refreshMixerUi();
    });
    solo?.addEventListener('click', () => {
        if (kind === 'drum') {
            toggleDrumSolo(index);
            return;
        }
        if (kind === 'osc') mix.oscSolo[index] = !mix.oscSolo[index];
        else if (kind === 'noise') mix.noiseSolo = !mix.noiseSolo;
        applyMixerMutes();
        refreshMixerUi();
    });
}

export function initMixer() {
    ensureMixer();
    const panel = document.getElementById('keyboardMixerPanel');
    if (!panel) return;
    ensureFaderChrome(panel);
    panel.querySelectorAll('.mixer-strip').forEach(wireStrip);
    document.addEventListener('ingysynth:drum-kit', refreshMixerUi);
    for (let i = 0; i < OSC_COUNT; i++) {
        subscribe(`osc-vol-${i}`, refreshMixerUi);
        subscribe(`osc-pan-${i}`, refreshMixerUi);
    }
    subscribe('noiseVol', refreshMixerUi);
    subscribe('volume', refreshMixerUi);
    refreshMixerUi();
    requestAnimationFrame(() => {
        syncMixerFaderCaps();
        requestAnimationFrame(syncMixerFaderCaps);
    });
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => syncMixerFaderCaps());
        ro.observe(panel);
        panel.querySelectorAll('.mixer-fader-slot').forEach((slot) => ro.observe(slot));
    }
}
