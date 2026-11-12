// Global D1–D4 dock between Steps and Automation. Bound to state.drumPatterns,
// which is the current P1–P8 drum slot (state.drumBank[state.drumSlot].lanes).

import { state } from './state.js?v=120';
import { bindKnob, refreshKnobDial } from './knobs.js?v=193';
import { get, set, subscribe, wireToggle } from './params.js?v=44';
import {
    STEP_SLOTS,
    DRUM_LANE_COUNT,
    clampDrumLane,
    ensureDrumPatterns,
    getDrumPattern,
    patternStepCount,
    patternGate,
    copyDrumPatternContent,
    pasteDrumPatternContent,
    clearDrumPatternSteps,
    copyDrumBank,
    pasteDrumBank,
    clearDrumBank,
    hasDrumBankClipboard,
    flashCopiedToast,
    syncPatternClipboardUi,
    ensureBerlinDrumKit,
    SONG_SLOT,
} from './pattern-bank.js?v=51';
import {
    BERLIN_COLORS,
    berlinStepDisplayValue,
    attachDrumChrome,
    setDrumMode,
    setBerlinDrumFilt,
    setDrumLanesHidden,
} from './berlin.js?v=126';
import { nextRatch, syncRatchButton } from './step-ratch.js?v=1';
import { toggleDrumMute, toggleDrumSolo } from './mixer.js?v=66';

const DIVISIONS = [
    { value: 2, label: '1/2' },
    { value: 3, label: '1/2T' },
    { value: 4, label: '1/4' },
    { value: 6, label: '1/4T' },
    { value: 8, label: '1/8' },
    { value: 12, label: '1/8T' },
    { value: 16, label: '1/16' },
    { value: 24, label: '1/16T' },
    { value: 48, label: '1/32T' },
];

const DRUM_COLORS = [BERLIN_COLORS[4], BERLIN_COLORS[5], BERLIN_COLORS[6], BERLIN_COLORS[7]];

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function drumDialId(lane, step) {
    return `drumDial-${lane}-${step}`;
}

function formatCents(cents) {
    const n = Math.round(Number(cents) || 0);
    return `${n > 0 ? '+' : ''}${n}¢`;
}

function snapCents(value) {
    if (!state.microtuneLock) return Math.max(-100, Math.min(100, Math.round(value)));
    return Math.max(-100, Math.min(100, Math.round(value / 25) * 25));
}

function fineStepAttr() {
    return state.microtuneLock ? '25' : '1';
}

function drumLegend(lane) {
    return `DRM ${lane + 1}`;
}

function buildStepCell(lane, step) {
    const cell = document.createElement('div');
    cell.className = 'berlin-step';
    cell.dataset.drumLane = String(lane);
    cell.dataset.step = String(step);
    cell.innerHTML = `
        <span class="berlin-step-num">${String(step + 1).padStart(2, '0')}</span>
        <div class="synth-knob berlin-step-knob">
            <div class="synth-knob-dial-wrap">
                <div class="synth-knob-dial" id="${drumDialId(lane, step)}" role="slider"
                     aria-label="${drumLegend(lane)} step ${step + 1} semitones"
                     aria-valuemin="-24" aria-valuemax="24" tabindex="0">
                    <span class="synth-knob-indicator"></span>
                </div>
            </div>
        </div>
        <span class="berlin-step-value">0</span>
        <input type="range" class="berlin-step-tune" min="-24" max="24" value="0" step="1"
               aria-hidden="true" tabindex="-1">
        <input type="range" class="berlin-step-fine" min="-100" max="100" value="0"
               step="${fineStepAttr()}"
               aria-label="${drumLegend(lane)} step ${step + 1} microtune cents">
        <span class="berlin-step-fine-value">0¢</span>
        <div class="berlin-step-buttons">
            <button type="button" class="berlin-step-btn berlin-step-acc off" aria-pressed="false">A</button>
            <button type="button" class="berlin-step-btn berlin-step-sld off" aria-pressed="false">S</button>
            <button type="button" class="berlin-step-btn berlin-step-ratch off" data-ratch="1" aria-pressed="false">Ratch</button>
            <button type="button" class="berlin-step-btn berlin-step-on off" aria-pressed="false">Off</button>
        </div>
    `;
    return cell;
}

function buildDrumRow(lane) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'berlin-row berlin-row-drum keyboard-drum-row';
    fieldset.dataset.drumLane = String(lane);
    fieldset.dataset.lane = 'drum';
    fieldset.style.setProperty('--berlin-color', DRUM_COLORS[lane] || '#4DA3FF');
    const legend = drumLegend(lane);
    const divOptions = DIVISIONS
        .map((d) => `<option value="${d.value}">${d.label}</option>`)
        .join('');
    fieldset.innerHTML = `
        <legend>
            <button type="button" class="legend-hex berlin-row-enable"
                    aria-label="${legend} on or off" aria-pressed="true">${legend}</button>
        </legend>
        <fieldset class="berlin-row-controls">
            <div class="berlin-row-controls-body">
                <div class="berlin-row-ms" role="group" aria-label="${legend} mute and solo">
                    <button type="button" class="berlin-row-mute berlin-step-btn off"
                            aria-label="${legend} mute" aria-pressed="false">Mute</button>
                    <button type="button" class="berlin-row-solo berlin-step-btn off"
                            aria-label="${legend} solo" aria-pressed="false">Solo</button>
                </div>
                <label class="berlin-ctl">
                    <span class="berlin-ctl-label">STEPS</span>
                    <input type="range" class="berlin-row-steps keyboard-master-tune-slider" min="1" max="32" value="8" step="1">
                    <span class="berlin-ctl-value berlin-row-steps-value">8</span>
                </label>
                <label class="berlin-ctl">
                    <span class="berlin-ctl-label">LENGTH</span>
                    <select class="berlin-row-division">${divOptions}</select>
                </label>
                <button type="button" class="berlin-row-rev berlin-step-btn off" aria-pressed="false">Rev</button>
                <label class="berlin-ctl berlin-ctl-gate">
                    <span class="berlin-ctl-label">GATE</span>
                    <input type="range" class="berlin-row-gate keyboard-master-tune-slider" min="5" max="100" value="90" step="1">
                    <span class="berlin-ctl-value berlin-row-gate-value">90</span>
                </label>
                <div class="berlin-row-clipboard" role="group" aria-label="${legend} clipboard">
                    <button type="button" class="berlin-row-copy berlin-step-btn pattern-copy-btn"
                            aria-label="Copy ${legend}">Copy</button>
                    <button type="button" class="berlin-row-paste berlin-step-btn pattern-paste-btn is-disabled"
                            aria-label="Paste into ${legend}" aria-disabled="true" disabled>Paste</button>
                    <button type="button" class="berlin-row-clear berlin-step-btn pattern-clear-btn"
                            aria-label="Clear ${legend} steps">Clear</button>
                </div>
            </div>
        </fieldset>
        <div class="berlin-row-steps-grid"></div>
    `;
    const grid = fieldset.querySelector('.berlin-row-steps-grid');
    for (let s = 0; s < STEP_SLOTS; s++) grid.appendChild(buildStepCell(lane, s));
    return fieldset;
}

function syncDrumStepCell(lane, step) {
    const pattern = getDrumPattern(lane);
    const data = pattern.steps[step] || {};
    const cell = document.querySelector(
        `.keyboard-drum-row[data-drum-lane="${lane}"] .berlin-step[data-step="${step}"]`
    );
    if (!cell) return;
    const input = cell.querySelector('.berlin-step-tune');
    const valueEl = cell.querySelector('.berlin-step-value');
    const tune = Math.round(Number(data.tune) || 0);
    if (input) {
        if (tune < parseFloat(input.min)) input.min = String(tune);
        if (tune > parseFloat(input.max)) input.max = String(tune);
        input.value = String(tune);
        refreshKnobDial(document.getElementById(drumDialId(lane, step)), input, null);
    }
    if (valueEl) valueEl.textContent = String(berlinStepDisplayValue(pattern, step, 0));
    const fine = cell.querySelector('.berlin-step-fine');
    const fineValue = cell.querySelector('.berlin-step-fine-value');
    const cents = Math.round(Number(data.fine) || 0);
    if (fine) {
        fine.step = fineStepAttr();
        fine.value = String(cents);
    }
    if (fineValue) fineValue.textContent = formatCents(cents);
    const acc = cell.querySelector('.berlin-step-acc');
    const sld = cell.querySelector('.berlin-step-sld');
    const on = cell.querySelector('.berlin-step-on');
    const ratch = cell.querySelector('.berlin-step-ratch');
    acc?.classList.toggle('off', !data.accent);
    acc?.setAttribute('aria-pressed', data.accent ? 'true' : 'false');
    sld?.classList.toggle('off', !data.slide);
    sld?.setAttribute('aria-pressed', data.slide ? 'true' : 'false');
    const isOn = data.on === true;
    if (on) {
        on.textContent = isOn ? 'On' : 'Off';
        on.classList.toggle('off', !isOn);
        on.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    syncRatchButton(ratch, data.ratch);
}

function syncDrumVisibleSteps(lane) {
    const count = patternStepCount(getDrumPattern(lane));
    document.querySelectorAll(`.keyboard-drum-row[data-drum-lane="${lane}"] .berlin-step`).forEach((cell) => {
        const step = parseInt(cell.dataset.step, 10);
        cell.classList.toggle('hidden', step >= count);
    });
    const grid = document.querySelector(`.keyboard-drum-row[data-drum-lane="${lane}"] .berlin-row-steps-grid`);
    if (grid) {
        grid.style.setProperty('--berlin-step-cols', String(Math.min(count, 16)));
        grid.style.setProperty('--berlin-step-cols-mobile', String(Math.min(count, 8)));
    }
}

function mixerAnySolo() {
    const mix = state.mixer || {};
    return (mix.oscSolo || []).some(Boolean)
        || !!mix.noiseSolo
        || (mix.drumSolo || []).some(Boolean);
}

function syncDrumMuteSoloUi(lane) {
    const fieldset = document.querySelector(`.keyboard-drum-row[data-drum-lane="${lane}"]`);
    if (!fieldset) return;
    const mix = state.mixer || {};
    const muteOn = !!mix.drumMute?.[lane];
    const soloOn = !!mix.drumSolo?.[lane];
    const anySolo = mixerAnySolo();
    fieldset.classList.toggle('is-muted', muteOn);
    fieldset.classList.toggle('is-solo', soloOn);
    fieldset.classList.toggle('is-solo-silenced', anySolo && !soloOn);
    const muteBtn = fieldset.querySelector('.berlin-row-mute');
    if (muteBtn) {
        muteBtn.classList.toggle('off', !muteOn);
        muteBtn.setAttribute('aria-pressed', muteOn ? 'true' : 'false');
    }
    const soloBtn = fieldset.querySelector('.berlin-row-solo');
    if (soloBtn) {
        soloBtn.classList.toggle('off', !soloOn);
        soloBtn.setAttribute('aria-pressed', soloOn ? 'true' : 'false');
    }
}

function syncAllDrumMuteSoloUi() {
    for (let i = 0; i < DRUM_LANE_COUNT; i++) syncDrumMuteSoloUi(i);
}

function syncDrumEnableUi(lane) {
    const fieldset = document.querySelector(`.keyboard-drum-row[data-drum-lane="${lane}"]`);
    if (!fieldset) return;
    const enabled = getDrumPattern(lane).enabled !== false;
    const btn = fieldset.querySelector('.berlin-row-enable');
    btn?.classList.toggle('off', !enabled);
    btn?.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    fieldset.classList.toggle('berlin-row-muted', !enabled);
    syncDrumMuteSoloUi(lane);
}

export function syncDrumLaneUi(lane) {
    const i = clampDrumLane(lane);
    const pattern = getDrumPattern(i);
    const fieldset = document.querySelector(`.keyboard-drum-row[data-drum-lane="${i}"]`);
    if (!fieldset) return;
    if (pattern.enabled === undefined) pattern.enabled = true;
    syncDrumEnableUi(i);
    const steps = fieldset.querySelector('.berlin-row-steps');
    const stepsValue = fieldset.querySelector('.berlin-row-steps-value');
    if (steps) steps.value = String(patternStepCount(pattern));
    if (stepsValue) stepsValue.textContent = String(patternStepCount(pattern));
    const div = fieldset.querySelector('.berlin-row-division');
    if (div) div.value = String(pattern.division);
    const rev = fieldset.querySelector('.berlin-row-rev');
    if (rev) {
        rev.classList.toggle('off', !pattern.reverse);
        rev.setAttribute('aria-pressed', pattern.reverse ? 'true' : 'false');
    }
    const gate = fieldset.querySelector('.berlin-row-gate');
    const gateValue = fieldset.querySelector('.berlin-row-gate-value');
    const gatePct = Math.round(patternGate(pattern) * 100);
    if (gate) gate.value = String(gatePct);
    if (gateValue) gateValue.textContent = String(gatePct);
    for (let s = 0; s < STEP_SLOTS; s++) syncDrumStepCell(i, s);
    syncDrumVisibleSteps(i);
    attachDrumChrome(fieldset, i);
}

function setDrumLaneEnabled(lane, on) {
    const pattern = getDrumPattern(lane);
    const next = !!on;
    pattern.enabled = next;
    syncDrumEnableUi(lane);
    if (!next) {
        document.dispatchEvent(new CustomEvent('ingysynth:berlin-drum-muted', {
            detail: { lane: clampDrumLane(lane) },
        }));
    }
}

function wireDrumRow(lane) {
    const fieldset = document.querySelector(`.keyboard-drum-row[data-drum-lane="${lane}"]`);
    if (!fieldset) return;
    // Live lookup: switching P1–P8 must edit the drum pattern now on screen.
    const pattern = new Proxy({}, {
        get(_target, prop) {
            const lanePattern = getDrumPattern(lane);
            const value = lanePattern[prop];
            return typeof value === 'function' ? value.bind(lanePattern) : value;
        },
        set(_target, prop, value) {
            getDrumPattern(lane)[prop] = value;
            return true;
        },
    });

    fieldset.querySelector('.berlin-row-enable')?.addEventListener('click', () => {
        setDrumLaneEnabled(lane, pattern.enabled === false);
    });
    fieldset.querySelector('.berlin-row-mute')?.addEventListener('click', () => {
        toggleDrumMute(lane);
    });
    fieldset.querySelector('.berlin-row-solo')?.addEventListener('click', () => {
        toggleDrumSolo(lane);
    });
    fieldset.querySelector('.berlin-row-copy')?.addEventListener('click', (e) => {
        copyDrumPatternContent(lane);
        flashCopiedToast(e.currentTarget);
    });
    fieldset.querySelector('.berlin-row-paste')?.addEventListener('click', () => {
        if (!pasteDrumPatternContent(lane)) return;
        const ph = state.drumPlayheads?.[lane];
        if (ph) ph.currentStep = Math.min(ph.currentStep, patternStepCount(getDrumPattern(lane)) - 1);
        syncDrumLaneUi(lane);
    });
    fieldset.querySelector('.berlin-row-clear')?.addEventListener('click', () => {
        clearDrumPatternSteps(lane);
        syncDrumLaneUi(lane);
    });
    fieldset.querySelector('.berlin-row-steps')?.addEventListener('input', (e) => {
        pattern.stepCount = clamp(parseInt(e.target.value, 10) || 8, 1, STEP_SLOTS);
        const label = fieldset.querySelector('.berlin-row-steps-value');
        if (label) label.textContent = String(pattern.stepCount);
        const ph = state.drumPlayheads?.[lane];
        if (ph) ph.currentStep = Math.min(ph.currentStep, pattern.stepCount - 1);
        syncDrumVisibleSteps(lane);
    });
    fieldset.querySelector('.berlin-row-division')?.addEventListener('change', (e) => {
        pattern.division = parseInt(e.target.value, 10) || 8;
    });
    fieldset.querySelector('.berlin-row-rev')?.addEventListener('click', (e) => {
        pattern.reverse = !pattern.reverse;
        e.currentTarget.classList.toggle('off', !pattern.reverse);
        e.currentTarget.setAttribute('aria-pressed', pattern.reverse ? 'true' : 'false');
    });
    fieldset.querySelector('.berlin-row-gate')?.addEventListener('input', (e) => {
        const pct = clamp(parseInt(e.target.value, 10) || 90, 5, 100);
        pattern.gate = pct / 100;
        const label = fieldset.querySelector('.berlin-row-gate-value');
        if (label) label.textContent = String(pct);
    });

    for (let s = 0; s < STEP_SLOTS; s++) {
        const cell = fieldset.querySelector(`.berlin-step[data-step="${s}"]`);
        if (!cell) continue;
        const input = cell.querySelector('.berlin-step-tune');
        const dial = document.getElementById(drumDialId(lane, s));
        const valueEl = cell.querySelector('.berlin-step-value');
        if (input && dial) {
            bindKnob(dial, input, null);
            input.addEventListener('input', () => {
                pattern.steps[s].tune = Math.round(parseFloat(input.value) || 0);
                if (valueEl) valueEl.textContent = String(berlinStepDisplayValue(pattern, s, 0));
            });
        }
        const fine = cell.querySelector('.berlin-step-fine');
        const fineValue = cell.querySelector('.berlin-step-fine-value');
        if (fine) {
            fine.addEventListener('input', () => {
                let cents = parseInt(fine.value, 10) || 0;
                if (state.microtuneLock) {
                    cents = snapCents(cents);
                    fine.value = String(cents);
                }
                pattern.steps[s].fine = cents;
                if (fineValue) fineValue.textContent = formatCents(cents);
            });
        }
        cell.querySelector('.berlin-step-acc')?.addEventListener('click', (e) => {
            pattern.steps[s].accent = !pattern.steps[s].accent;
            e.currentTarget.classList.toggle('off', !pattern.steps[s].accent);
            e.currentTarget.setAttribute('aria-pressed', pattern.steps[s].accent ? 'true' : 'false');
        });
        cell.querySelector('.berlin-step-sld')?.addEventListener('click', (e) => {
            pattern.steps[s].slide = !pattern.steps[s].slide;
            e.currentTarget.setAttribute('aria-pressed', pattern.steps[s].slide ? 'true' : 'false');
            e.currentTarget.classList.toggle('off', !pattern.steps[s].slide);
        });
        cell.querySelector('.berlin-step-on')?.addEventListener('click', (e) => {
            const next = pattern.steps[s].on !== true;
            pattern.steps[s].on = next;
            e.currentTarget.textContent = next ? 'On' : 'Off';
            e.currentTarget.classList.toggle('off', !next);
            e.currentTarget.setAttribute('aria-pressed', next ? 'true' : 'false');
        });
        cell.querySelector('.berlin-step-ratch')?.addEventListener('click', (e) => {
            if (state.acidMode) return;
            const next = nextRatch(pattern.steps[s].ratch);
            pattern.steps[s].ratch = next;
            syncRatchButton(e.currentTarget, next);
        });
    }
}

const drumActiveStep = [];

export function setDrumStepActive(lane, step) {
    const i = clampDrumLane(lane);
    const prev = drumActiveStep[i];
    if (prev === step) return;
    if (prev != null) {
        document.querySelector(
            `.keyboard-drum-row[data-drum-lane="${i}"] .berlin-step[data-step="${prev}"]`
        )?.classList.remove('active');
    }
    if (step !== null && step !== undefined) {
        document.querySelector(
            `.keyboard-drum-row[data-drum-lane="${i}"] .berlin-step[data-step="${step}"]`
        )?.classList.add('active');
    }
    drumActiveStep[i] = step;
}

export function clearDrumStepActive() {
    for (let i = 0; i < DRUM_LANE_COUNT; i++) setDrumStepActive(i, null);
}

function syncAllDrumLanes() {
    for (let i = 0; i < DRUM_LANE_COUNT; i++) syncDrumLaneUi(i);
}

let dockBuilt = false;

export function initDrumDock() {
    if (dockBuilt) return;
    const host = document.getElementById('keyboardDrumLanes');
    if (!host) return;
    ensureDrumPatterns();
    ensureBerlinDrumKit();
    host.innerHTML = '';
    for (let i = 0; i < DRUM_LANE_COUNT; i++) host.appendChild(buildDrumRow(i));
    for (let i = 0; i < DRUM_LANE_COUNT; i++) {
        wireDrumRow(i);
        syncDrumLaneUi(i);
    }
    dockBuilt = true;

    const modeBtn = document.getElementById('kbDrumMode');
    const filtBtn = document.getElementById('kbDrumFilt');
    const hideBtn = document.getElementById('kbDrumHide');
    if (modeBtn) wireToggle(modeBtn, 'drumModeToggle', { syncLabel: false });
    if (filtBtn) wireToggle(filtBtn, 'drumFiltToggle', { syncLabel: false });
    hideBtn?.addEventListener('click', () => {
        setDrumLanesHidden(!state.berlinDrumLanesHidden);
    });
    subscribe('drumModeToggle', (on) => setDrumMode(!!on));
    subscribe('drumFiltToggle', (on) => setBerlinDrumFilt(!!on));
    if (get('drumModeToggle') !== !!state.berlinDrumMode) {
        set('drumModeToggle', !!state.berlinDrumMode);
    }
    if (get('drumFiltToggle') !== !!state.berlinDrumFilt) {
        set('drumFiltToggle', !!state.berlinDrumFilt);
    }
    setDrumMode(!!get('drumModeToggle'));
    setBerlinDrumFilt(!!get('drumFiltToggle'));

    document.addEventListener('ingysynth:pattern-clipboard', (e) => {
        syncPatternClipboardUi();
        const slot = e.detail?.slot;
        if (e.detail?.action !== 'paste' || typeof slot !== 'number') return;
        if ((slot | 0) !== (state.drumSlot | 0) || !dockBuilt) return;
        syncAllDrumLanes();
    });
    document.addEventListener('ingysynth:drum-slot', () => {
        clearDrumStepActive();
        if (!dockBuilt) return;
        syncAllDrumLanes();
    });
    document.addEventListener('ingysynth:mixer-mutes', syncAllDrumMuteSoloUi);
    document.addEventListener('ingysynth:drum-kit', (e) => {
        const lane = e.detail?.lane;
        if (lane == null) {
            for (let i = 0; i < DRUM_LANE_COUNT; i++) syncDrumLaneUi(i);
        } else {
            const fieldset = document.querySelector(`.keyboard-drum-row[data-drum-lane="${lane}"]`);
            if (fieldset) attachDrumChrome(fieldset, lane);
        }
    });
    wireDrumBankClipboard();
    syncPatternClipboardUi();
}

function syncDrumBankPasteUi() {
    const btn = document.getElementById('drumPatternPaste');
    if (!btn) return;
    const has = hasDrumBankClipboard();
    btn.disabled = !has;
    btn.setAttribute('aria-disabled', has ? 'false' : 'true');
    btn.classList.toggle('is-disabled', !has);
}

function wireDrumBankClipboard() {
    const blocked = () => (state.drumSlot | 0) === SONG_SLOT;
    document.getElementById('drumPatternCopy')?.addEventListener('click', (e) => {
        if (blocked()) return;
        copyDrumBank(state.drumSlot);
        syncDrumBankPasteUi();
        flashCopiedToast(e.currentTarget);
    });
    document.getElementById('drumPatternPaste')?.addEventListener('click', () => {
        if (blocked()) return;
        if (!pasteDrumBank(state.drumSlot)) return;
        if (dockBuilt) syncAllDrumLanes();
    });
    document.getElementById('drumPatternClear')?.addEventListener('click', () => {
        if (blocked()) return;
        clearDrumBank(state.drumSlot);
        if (dockBuilt) syncAllDrumLanes();
    });
    syncDrumBankPasteUi();
}
