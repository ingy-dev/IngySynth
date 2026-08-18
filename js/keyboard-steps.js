// Compact collapsible step strip — full width between tempo row and bend.
// Each step mirrors the Sequencer section: semitone knob → .step-tune,
// tiny microtune → .step-fine, Acc/Sld/On → accent/slide/toggle.

import { state } from './state.js?v=114';
import { getQuantizedStepTune } from './tuning.js?v=79';
import { bindKnob } from './knobs.js?v=121';
import { setCollapsibleExpanded } from './collapsible.js?v=74';
import {
    click,
    elementFor,
    get,
    set,
    subscribe,
    toggle,
} from './params.js?v=13';
import {
    setWriteCursor,
    syncWriteToolbarFromStep,
} from './pattern-write.js?v=102';
import { syncRatchButton } from './step-ratch.js?v=1';

const STEP_COUNT = 32;

function formatKbCents(cents) {
    const n = Math.round(Number(cents) || 0);
    return `${n > 0 ? '+' : ''}${n}¢`;
}

function syncKbButtonFromKey(kbBtn, key) {
    if (!kbBtn) return;
    const on = !!get(key);
    kbBtn.classList.toggle('off', !on);
    kbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function syncKbToggleFromKey(kbBtn, key) {
    if (!kbBtn) return;
    const on = !!get(key);
    kbBtn.classList.toggle('off', !on);
    kbBtn.textContent = on ? 'On' : 'Off';
    kbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function refreshKbStepTuneValue(step) {
    const valueEl = document.querySelector(`.kb-step-tune-value[data-step="${step}"]`);
    if (valueEl) valueEl.textContent = String(getQuantizedStepTune(step));
}

export function syncKeyboardStepFineFromMain(step) {
    const fineMain = elementFor(`step-fine-${step}`);
    const kbFine = document.querySelector(`.kb-step-fine[data-step="${step}"]`);
    const kbFineVal = document.querySelector(`.kb-step-fine-value[data-step="${step}"]`);
    if (!kbFine) return;
    const v = get(`step-fine-${step}`);
    if (v != null) kbFine.value = String(v);
    if (fineMain) kbFine.step = fineMain.step || '1';
    if (kbFineVal) kbFineVal.textContent = formatKbCents(kbFine.value);
}

export function syncAllKeyboardStepFinesFromMain() {
    for (let i = 0; i < STEP_COUNT; i++) {
        syncKeyboardStepFineFromMain(i);
    }
}

function syncKbRatchFromMain(kbBtn, step) {
    if (!kbBtn) return;
    syncRatchButton(kbBtn, get(`step-ratch-${step}`));
}

export function syncKeyboardStepButtonsFromMain(step) {
    const kbAcc = document.querySelector(`.kb-step-accent[data-step="${step}"]`);
    const kbSld = document.querySelector(`.kb-step-slide[data-step="${step}"]`);
    const kbOn = document.querySelector(`.kb-step-toggle[data-step="${step}"]`);
    const kbRatch = document.querySelector(`.kb-step-ratch[data-step="${step}"]`);

    syncKbButtonFromKey(kbAcc, `step-accent-${step}`);
    syncKbButtonFromKey(kbSld, `step-slide-${step}`);
    syncKbToggleFromKey(kbOn, `step-toggle-${step}`);
    syncKbRatchFromMain(kbRatch, step);
}

export function syncAllKeyboardStepButtonsFromMain() {
    for (let i = 0; i < STEP_COUNT; i++) {
        syncKeyboardStepButtonsFromMain(i);
    }
}

export function refreshKeyboardStepTuneReadouts() {
    for (let i = 0; i < STEP_COUNT; i++) refreshKbStepTuneValue(i);
}

export function updateKeyboardStepVisibility(stepCount) {
    const count = Math.max(1, Math.min(STEP_COUNT, Math.round(Number(stepCount)) || 1));
    document.querySelectorAll('.keyboard-step').forEach((stepEl) => {
        const stepIndex = parseInt(stepEl.dataset.step, 10);
        stepEl.classList.toggle('hidden', stepIndex >= count);
    });

    const grid = document.getElementById('keyboardStepsGrid')
        || document.getElementById('keyboardStepsPanel');
    if (!grid) return;

    // Cap at 16 (desktop) / 8 (mobile). Never pick a divisor — primes like 23
    // would collapse to 1 column. Last row may be short; that's fine.
    grid.style.setProperty('--kb-step-cols', String(Math.min(count, 16)));
    grid.style.setProperty('--kb-step-cols-mobile', String(Math.min(count, 8)));
}

export function setKeyboardStepActive(step) {
    document.querySelectorAll('.keyboard-step').forEach((el) => el.classList.remove('active'));
    if (step === null || step === undefined) return;
    const current = document.querySelector(`.keyboard-step[data-step="${step}"]`);
    if (current && !current.classList.contains('hidden')) {
        current.classList.add('active');
    }
}

function syncStepsCollapseUI() {
    const fieldset = document.getElementById('keyboardStepsFieldset');
    setCollapsibleExpanded(fieldset, state.keyboardStepsExpanded);
}

export function syncKeyboardStepsVisibilityWithKeyboard() {
    const fieldset = document.getElementById('keyboardStepsFieldset');
    if (!fieldset) return;
    fieldset.style.display = '';
}

function buildStep(i) {
    const stepEl = document.createElement('fieldset');
    stepEl.className = 'keyboard-step';
    stepEl.dataset.step = String(i);

    const legend = document.createElement('legend');
    legend.textContent = String(i + 1).padStart(2, '0');
    stepEl.appendChild(legend);

    const knob = document.createElement('div');
    knob.className = 'synth-knob keyboard-step-knob';
    knob.innerHTML = `
        <div class="synth-knob-dial-wrap">
            <div class="synth-knob-dial kb-step-tune-dial" id="kbStepTuneDial${i}" role="slider"
                 aria-label="Step ${i + 1} semitones" aria-valuemin="-39" aria-valuemax="48" tabindex="0">
                <span class="synth-knob-indicator"></span>
            </div>
        </div>
        <span class="synth-knob-value kb-step-tune-value" data-step="${i}">0</span>
        <input type="range" class="kb-step-fine" data-step="${i}"
               min="-100" max="100" value="0" step="1"
               aria-label="Step ${i + 1} microtune cents">
        <span class="kb-step-fine-value" data-step="${i}">0¢</span>
    `;
    stepEl.appendChild(knob);

    const buttons = document.createElement('div');
    buttons.className = 'keyboard-step-buttons';
    buttons.innerHTML = `
        <button type="button" class="kb-step-btn kb-step-accent off" data-step="${i}" aria-label="Step ${i + 1} accent" aria-pressed="false">Acc</button>
        <button type="button" class="kb-step-btn kb-step-slide off" data-step="${i}" aria-label="Step ${i + 1} slide" aria-pressed="false">Sld</button>
        <button type="button" class="kb-step-btn kb-step-ratch kb-step-ratch-full off" data-step="${i}" data-ratch="1" aria-label="Step ${i + 1} ratchet" aria-pressed="false">Ratch</button>
        <button type="button" class="kb-step-btn kb-step-toggle kb-step-toggle-full" data-step="${i}" aria-label="Step ${i + 1} on or off" aria-pressed="true">On</button>
    `;
    stepEl.appendChild(buttons);

    return stepEl;
}

function wireStep(i) {
    const dial = document.getElementById(`kbStepTuneDial${i}`);
    const valueEl = document.querySelector(`.kb-step-tune-value[data-step="${i}"]`);
    if (dial) {
        bindKnob(dial, `step-slider-${i}`, null);
        const updateValue = () => {
            if (valueEl) valueEl.textContent = String(getQuantizedStepTune(i));
        };
        elementFor(`step-slider-${i}`)?.addEventListener('input', updateValue);
        subscribe(`step-slider-${i}`, updateValue);
        updateValue();
    }

    const kbFine = document.querySelector(`.kb-step-fine[data-step="${i}"]`);
    if (kbFine) {
        const syncFromStore = () => syncKeyboardStepFineFromMain(i);
        kbFine.addEventListener('input', () => {
            if (state.keyboardWrite && i !== state.writeStep) {
                setWriteCursor(i);
            }
            set(`step-fine-${i}`, parseFloat(kbFine.value));
            syncFromStore();
            if (state.keyboardWrite) syncWriteToolbarFromStep();
        });
        subscribe(`step-fine-${i}`, syncFromStore);
        syncFromStore();
    }

    const kbAcc = document.querySelector(`.kb-step-accent[data-step="${i}"]`);
    const kbSld = document.querySelector(`.kb-step-slide[data-step="${i}"]`);
    const kbOn = document.querySelector(`.kb-step-toggle[data-step="${i}"]`);
    const kbRatch = document.querySelector(`.kb-step-ratch[data-step="${i}"]`);

    syncKeyboardStepButtonsFromMain(i);

    const seekIfWrite = () => {
        if (state.keyboardWrite && i !== state.writeStep) setWriteCursor(i);
    };

    kbAcc?.addEventListener('click', (e) => {
        if (state.keyboardWrite) {
            e.preventDefault();
            e.stopPropagation();
            seekIfWrite();
            toggle(`step-accent-${i}`);
            syncWriteToolbarFromStep();
            return;
        }
        toggle(`step-accent-${i}`);
    });
    kbSld?.addEventListener('click', (e) => {
        if (state.keyboardWrite) {
            e.preventDefault();
            e.stopPropagation();
            seekIfWrite();
            toggle(`step-slide-${i}`);
            syncWriteToolbarFromStep();
            return;
        }
        toggle(`step-slide-${i}`);
    });
    kbOn?.addEventListener('click', () => {
        seekIfWrite();
        toggle(`step-toggle-${i}`);
        if (state.keyboardWrite) syncWriteToolbarFromStep();
    });
    kbRatch?.addEventListener('click', (e) => {
        if (state.acidMode) return;
        if (state.keyboardWrite) {
            e.preventDefault();
            e.stopPropagation();
            seekIfWrite();
            click(`step-ratch-${i}`);
            syncWriteToolbarFromStep();
            return;
        }
        click(`step-ratch-${i}`);
    });

    const afterFlag = () => {
        syncKeyboardStepButtonsFromMain(i);
        if (state.keyboardWrite && i === state.writeStep) syncWriteToolbarFromStep();
    };
    subscribe(`step-accent-${i}`, afterFlag);
    subscribe(`step-slide-${i}`, afterFlag);
    subscribe(`step-toggle-${i}`, afterFlag);
    subscribe(`step-ratch-${i}`, afterFlag);
}

export function initKeyboardSteps() {
    const panel = document.getElementById('keyboardStepsPanel');
    const grid = document.getElementById('keyboardStepsGrid') || panel;
    if (!grid) return;

    grid.innerHTML = '';
    for (let i = 0; i < STEP_COUNT; i++) {
        grid.appendChild(buildStep(i));
    }
    for (let i = 0; i < STEP_COUNT; i++) {
        wireStep(i);
    }

    // In Write mode, clicking a step selects it as the write target (VFD + cursor).
    // Knobs still edit tune; Acc/Sld/On handlers above also seek when needed.
    grid.addEventListener('click', (e) => {
        if (!state.keyboardWrite) return;
        const stepEl = e.target.closest('.keyboard-step');
        if (!stepEl || !grid.contains(stepEl)) return;
        // Let Acc/Sld handlers own their clicks (they already seek)
        if (e.target.closest('.kb-step-accent, .kb-step-slide, .kb-step-ratch')) return;
        // Fine slider seeks in its own input handler
        if (e.target.closest('.kb-step-fine')) return;
        const step = parseInt(stepEl.dataset.step, 10);
        if (!Number.isFinite(step)) return;
        setWriteCursor(step);
    });

    const stepCountEl = document.getElementById('stepCount');
    const count = stepCountEl ? parseInt(stepCountEl.value, 10) : 8;
    updateKeyboardStepVisibility(count);

    state.keyboardStepsExpanded = true;
    syncStepsCollapseUI();
    syncKeyboardStepsVisibilityWithKeyboard();

    document.getElementById('keyboardStepsToggle')?.addEventListener('click', () => {
        state.keyboardStepsExpanded = !state.keyboardStepsExpanded;
        syncStepsCollapseUI();
    });

    document.addEventListener('ingysynth-kb-steps-sync', () => {
        syncAllKeyboardStepButtonsFromMain();
        syncAllKeyboardStepFinesFromMain();
        refreshKeyboardStepTuneReadouts();
    });
}
