// Opt-in CP10 smoke tracker. Load with index.html?cp10smoke
// Does not run on a normal boot. Proofs that remove classic nodes are
// destructive for this page lifetime — hard-refresh when finished.

import { state } from './state.js?v=114';
import {
    get, getNumber, getString, getOscType, getOscVol, set, subscribe,
} from './params.js?v=13';
import { flushDomToPattern, getLiveStep, selectSlot } from './pattern-bank.js?v=12';
import { followXYPadAutomation, getXYPadAutomationKeys } from './xy-pad.js?v=78';

const STORAGE = 'ingysynth-cp10-smoke-v1';
const PANEL_ID = 'cp10-smoke-panel';

const ITEMS = [
    { id: 'boot', group: 'start', kind: 'ear', title: 'Boot',
      hint: 'Hard refresh. No red console. Green/black stage. Start plays. No wood.' },
    { id: 'core', group: 'start', kind: 'ear', title: 'Core play (~5 min)',
      hint: 'Start/Stop + spacebar. Hold + Latch. Tempo/DIV/STEPS while playing. Write 8 (note/rest/acc/sld/ratch). Cutoff/res/vol. Osc 1–4 + OSC4 analog/digital. Master tune/octave.' },
    { id: 'rec-watch', group: 'proof', kind: 'watch', title: '1. Rec cutoff — no #cutoff input',
      hint: 'Arm, then Rec one loop and drag STAGE cutoff. Score. Hidden #cutoff must not see input/change. Then confirm playback by ear.' },
    { id: 'rec-playback', group: 'proof', kind: 'ear', title: 'Rec playback rides filter',
      hint: 'After the watch passes: play the take. Filter must move. UI-moves-sound-does-not is a fail.' },
    { id: 'cutoff-set', group: 'proof', kind: 'run', title: '2. #cutoff.remove + params.set(800)',
      hint: 'Click the stage first (audio). Rec must already be scored. Filter floor should follow.' },
    { id: 'filter-env', group: 'proof', kind: 'run', title: '3. Filter-env after button gone',
      hint: 'Removes #filterEnvToggle, then params.set flips state.filterEnvState.' },
    { id: 'start-kb', group: 'proof', kind: 'ear', title: 'Start from #kbStartStop',
      hint: 'Do not count hidden #startStop. Optional: remove #startStop in inspector, then Start on stage.' },
    { id: 'osc-set', group: 'proof', kind: 'run', title: '4. Osc params.set after classic nodes gone',
      hint: 'Removes osc 0 vol/toggle/type, then set vol/toggle/type. Sound must follow — confirm by ear too.' },
    { id: 'transport-fx', group: 'proof', kind: 'ear', title: 'Osc / chorus / delay / LFO / DIV',
      hint: 'Osc on/off, chorus I/II, delay select, LFO on/retrig/sync, DIV. Sound matches UI.' },
    { id: 'write-line', group: 'proof', kind: 'ear', title: 'Write acc/sld/on/ratch',
      hint: 'Program a line. Buttons and audio agree.' },
    { id: 'p1-p2', group: 'proof', kind: 'run', title: '5. P1→P2 does not zero steps',
      hint: 'Stop first. Writes a sentinel tune on step 0, switches P2 then P1.' },
    { id: 'flush-noop', group: 'proof', kind: 'run', title: '6. flushDomToPattern no-op on steps without bus',
      hint: 'Removes #stepParamBus, flushes, live step tune must stay.' },
    { id: 'midi-learn', group: 'proof', kind: 'run', title: '7. MIDI learn stored cutoff',
      hint: 'Learn cutoff from stage (and Ingy if open) with canonical node gone, then Run. Must store cutoff, not ingy6-cutoff. Hardware CC is not this test.' },
    { id: 'xy-follow', group: 'proof', kind: 'run', title: '8. XY cutoff follow via store',
      hint: 'Assigns X=cutoff, params.set two values, checks pointer. Drag-by-ear is the next row.' },
    { id: 'xy-drag', group: 'proof', kind: 'ear', title: 'XY cutoff drag',
      hint: 'Expand XY. Assign cutoff. Drag pad. Filter moves. No scrape onto kbSlideTime / kbWriteFineProxy.' },
    { id: 'semitone-7', group: 'proof', kind: 'run', title: 'Semitone amount is 7',
      hint: 'Store + stage selects. Run asserts params.get; confirm selects by eye.' },
    { id: 'kb-adsr', group: 'proof', kind: 'ear', title: 'Kb ADSR paints and drags',
      hint: 'VFD paints. Drag changes attack/decay/sustain/release in the store and in the sound.' },
    { id: 'acid-osc1', group: 'proof', kind: 'ear', title: 'Acid enter does not mute osc 1',
      hint: 'Enter Acid. Osc 1 still sounds. CP9 audio niggles are not a fail.' },
    { id: 'kit-acid', group: 'kit', kind: 'ear', title: 'Acid strip', hint: 'Decay/accent/slide feel right.' },
    { id: 'kit-fx', group: 'kit', kind: 'ear', title: 'FX + ADSR + LFO',
      hint: 'Amp+filter ADSR knobs and VFD. LFO Hz/sync, dests, retrig, amount strip.' },
    { id: 'kit-unison', group: 'kit', kind: 'ear', title: 'Unison / phase / ring / noise', hint: '' },
    { id: 'kit-bank', group: 'kit', kind: 'ear', title: 'Bank copy/paste/clear + shift', hint: '' },
    { id: 'kit-modes', group: 'kit', kind: 'ear', title: 'Berlin / Poly / Multitudes / Ingy-6',
      hint: 'Enter-tweak-exit. Must not double-toggle or zero osc vol.' },
    { id: 'kit-auto', group: 'kit', kind: 'ear', title: 'Automation undo / clear',
      hint: 'After the Rec proof: undo, clear. Maps are in-session only.' },
    { id: 'kit-xy2', group: 'kit', kind: 'ear', title: 'XY two axes + None', hint: '' },
    { id: 'kit-midi', group: 'kit', kind: 'ear', title: 'MIDI notes + Mapping',
      hint: 'In-session only. Hardware CC is not a gate.' },
    { id: 'kit-ckb', group: 'kit', kind: 'ear', title: 'Computer-keys vs chromatic', hint: '' },
    { id: 'kit-off', group: 'kit', kind: 'ear', title: 'Keyboard Off',
      hint: 'Off on screen without opening a panel. Piano/ckb/spacebar hide. Transport/Start/knobs/XY stay. Stage stays #050805.' },
    { id: 'kit-phone', group: 'kit', kind: 'ear', title: 'Phone',
      hint: 'No wood. No swipe-dot paging. Arrows do not steal keys for section swipe.' },
    { id: 'kit-console', group: 'kit', kind: 'ear', title: 'Console clean',
      hint: 'No TypeError. CP9 audio niggles are not this row.' },
];

const GROUPS = [
    { id: 'start', label: 'Session' },
    { id: 'proof', label: 'Proofs (order matters)' },
    { id: 'kit', label: 'Full kit' },
];

let results = loadResults();
let recHits = 0;
let recArmed = false;
let recListener = null;
let recTarget = null;
let logEl = null;

function loadResults() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE) || '{}');
        return raw && typeof raw === 'object' ? raw : {};
    } catch {
        return {};
    }
}

function saveResults() {
    localStorage.setItem(STORAGE, JSON.stringify(results));
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(detail) {
    return { ok: true, detail: detail || '' };
}

function fail(detail) {
    return { ok: false, detail: String(detail || 'failed') };
}

function needAudio() {
    if (!state.audioContext) return fail('Click the stage first — audio is not inited');
    return null;
}

function setStatus(id, status, detail) {
    results[id] = { status, detail: detail || '', at: new Date().toISOString() };
    saveResults();
    paintItem(id);
    paintHeader();
    logLine(`${id}: ${status}${detail ? ` — ${detail}` : ''}`);
}

function logLine(text) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.textContent = text;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

function itemById(id) {
    return ITEMS.find((it) => it.id === id);
}

function recCutoffEl() {
    return document.getElementById('cutoff');
}

function onCutoffDomEvent(e) {
    if (e.type !== 'input' && e.type !== 'change') return;
    recHits += 1;
    logLine(`#cutoff ${e.type} (#${recHits}) — Rec false-pass if this fires from stage drag`);
}

function armRecWatch() {
    const el = recCutoffEl();
    if (!el) return fail('#cutoff already gone — hard refresh and Rec BEFORE remove');
    if (recListener && recTarget) {
        recTarget.removeEventListener('input', recListener, true);
        recTarget.removeEventListener('change', recListener, true);
    }
    recHits = 0;
    recArmed = true;
    recTarget = el;
    recListener = onCutoffDomEvent;
    el.addEventListener('input', recListener, true);
    el.addEventListener('change', recListener, true);
    return ok('Armed. Rec + drag stage cutoff, then Score.');
}

function scoreRecWatch() {
    if (!recArmed) return fail('Arm first');
    if (recTarget) {
        recTarget.removeEventListener('input', recListener, true);
        recTarget.removeEventListener('change', recListener, true);
    }
    recArmed = false;
    const stillThere = !!recCutoffEl()?.isConnected;
    if (!stillThere) return fail('#cutoff was removed before Score — Rec proof is invalid');
    if (recHits > 0) {
        return fail(`${recHits} input/change on #cutoff — Rec still on the classic node`);
    }
    return ok('No #cutoff input/change. Mark Rec playback by ear.');
}

async function runCutoffSet() {
    const audioFail = needAudio();
    if (audioFail) return audioFail;
    const rec = results['rec-watch'];
    if (rec?.status !== 'pass' && rec?.status !== 'skip') {
        return fail('Score Rec watch first (or Skip if you already did it this session)');
    }
    const el = recCutoffEl();
    if (el) {
        let lateHits = 0;
        const spy = () => { lateHits += 1; };
        el.addEventListener('input', spy, true);
        el.addEventListener('change', spy, true);
        el.remove();
        const target = getNumber('cutoff', 1500) === 800 ? 1200 : 800;
        let notified = 0;
        const unsub = subscribe('cutoff', () => { notified += 1; });
        set('cutoff', target);
        await wait(80);
        unsub();
        el.removeEventListener('input', spy, true);
        el.removeEventListener('change', spy, true);
        if (lateHits) return fail(`detached #cutoff still got ${lateHits} event(s)`);
        if (getNumber('cutoff') !== target) return fail(`store is ${get('cutoff')}, wanted ${target}`);
        // subscribe() applies once at bind; set() must fire a second notify
        if (notified < 2) return fail('set() did not notify cutoff subscribers');
        const floor = state.filterCutoffMin?.offset?.value;
        const envOn = !!state.filterEnvState;
        const bits = [`store=${target}`, `notified`, floor != null ? `floorHz=${Math.round(floor)}` : 'no AudioParam yet'];
        if (!envOn && Number.isFinite(floor) && Math.abs(floor - target) > 80) {
            return fail(`${bits.join('; ')} — floor did not follow (env off)`);
        }
        return ok(bits.join('; '));
    }
    const target = getNumber('cutoff', 1500) === 800 ? 1200 : 800;
    set('cutoff', target);
    await wait(80);
    if (getNumber('cutoff') !== target) return fail(`store is ${get('cutoff')}`);
    return ok(`#cutoff already gone; store=${target}`);
}

async function runFilterEnv() {
    const audioFail = needAudio();
    if (audioFail) return audioFail;
    document.getElementById('filterEnvToggle')?.remove();
    const want = !state.filterEnvState;
    set('filterEnvToggle', want);
    await wait(40);
    if (!!state.filterEnvState !== want) {
        return fail(`filterEnvState=${state.filterEnvState}, wanted ${want}`);
    }
    if (document.getElementById('filterEnvToggle')) {
        return fail('#filterEnvToggle still in the document');
    }
    return ok(`filterEnvState=${want}`);
}

async function runOscSet() {
    const audioFail = needAudio();
    if (audioFail) return audioFail;
    document.querySelectorAll(
        '.osc-vol[data-osc="0"], .osc-toggle[data-osc="0"], .osc-type[data-osc="0"], .osc-tune[data-osc="0"], .osc-pan[data-osc="0"]',
    ).forEach((n) => n.remove());
    const volTarget = Math.abs(getOscVol(0) - 0.5) < 0.02 ? 0.7 : 0.5;
    set('osc-vol-0', volTarget);
    set('osc-toggle-0', true);
    const typeNow = getOscType(0);
    const typeTarget = typeNow === 'square' ? 'sawtooth' : 'square';
    set('osc-type-0', typeTarget);
    await wait(40);
    if (Math.abs(getOscVol(0) - volTarget) > 0.02) return fail(`vol=${getOscVol(0)}`);
    if (!state.oscStates?.[0]) return fail('oscStates[0] is off');
    if (getOscType(0) !== typeTarget) return fail(`type=${getOscType(0)}`);
    return ok(`vol=${volTarget} type=${typeTarget} (confirm by ear)`);
}

async function runP1P2() {
    if (state.berlinMode) return fail('Exit Berlin first');
    if (state.isPlaying || state.isArping) return fail('Stop first');
    const sentinel = getLiveStep(0).tune === 7 ? 11 : 7;
    set('step-slider-0', sentinel);
    if (getLiveStep(0).tune !== sentinel) return fail('could not write live step 0');
    selectSlot(1);
    selectSlot(0);
    const got = getLiveStep(0).tune;
    if (got !== sentinel) return fail(`step 0 tune=${got} after P1→P2→P1 (wanted ${sentinel})`);
    return ok(`step 0 tune stayed ${sentinel}`);
}

async function runFlushNoop() {
    if (state.isPlaying || state.isArping) return fail('Stop first');
    const sentinel = getLiveStep(0).tune === 13 ? 17 : 13;
    set('step-slider-0', sentinel);
    document.getElementById('stepParamBus')?.remove();
    flushDomToPattern(state.editSlot);
    const got = getLiveStep(0).tune;
    if (got !== sentinel) return fail(`flush overwrote tune to ${got}`);
    return ok(`bus gone; tune stayed ${sentinel}`);
}

function runMidiLearn() {
    const maps = state.midiMappings || {};
    const keys = Object.keys(maps);
    const ingy = keys.filter((k) => /ingy6/i.test(k));
    if (ingy.length) return fail(`stored ${ingy.join(', ')} — wanted catalog cutoff`);
    if (!Object.prototype.hasOwnProperty.call(maps, 'cutoff')) {
        return fail(`no cutoff mapping yet (have: ${keys.join(', ') || 'none'}). Learn from stage, then Run.`);
    }
    return ok('midiMappings.cutoff present');
}

async function runXyFollow() {
    const xSel = document.getElementById('xAxisParam');
    const pointer = document.getElementById('xyPointer');
    if (!xSel || !pointer) return fail('XY controls missing');
    xSel.value = 'cutoff';
    xSel.dispatchEvent(new Event('change', { bubbles: true }));
    const keys = getXYPadAutomationKeys();
    if (keys.x !== 'cutoff') return fail(`X key is ${keys.x}`);
    set('cutoff', 20);
    await wait(40);
    const leftAfterSetLow = pointer.style.left;
    followXYPadAutomation({ x: true });
    await wait(20);
    const leftLow = parseFloat(pointer.style.left) || 0;
    set('cutoff', 10000);
    await wait(40);
    const leftAfterSetHigh = pointer.style.left;
    followXYPadAutomation({ x: true });
    await wait(20);
    const leftHigh = parseFloat(pointer.style.left) || 0;
    const setAloneMoved = leftAfterSetLow !== leftAfterSetHigh;
    if (!(leftHigh > leftLow + 5)) {
        return fail(`pointer did not follow store (${leftLow}% → ${leftHigh}%)`);
    }
    return ok(setAloneMoved
        ? `pointer ${leftLow.toFixed(0)}% → ${leftHigh.toFixed(0)}%; params.set moved it`
        : `pointer ${leftLow.toFixed(0)}% → ${leftHigh.toFixed(0)}% after followXYPadAutomation (set alone did not move — playback tick still owns follow)`);
}

function runSemitone() {
    const v = getString('semitoneAmount', '');
    if (v !== '7' && getNumber('semitoneAmount', 0) !== 7) {
        return fail(`semitoneAmount=${v}`);
    }
    return ok('semitoneAmount=7');
}

const RUNNERS = {
    'cutoff-set': runCutoffSet,
    'filter-env': runFilterEnv,
    'osc-set': runOscSet,
    'p1-p2': runP1P2,
    'flush-noop': runFlushNoop,
    'midi-learn': runMidiLearn,
    'xy-follow': runXyFollow,
    'semitone-7': runSemitone,
};

function counts() {
    let pass = 0;
    let failN = 0;
    let skip = 0;
    ITEMS.forEach((it) => {
        const s = results[it.id]?.status;
        if (s === 'pass') pass += 1;
        else if (s === 'fail') failN += 1;
        else if (s === 'skip') skip += 1;
    });
    return { pass, failN, skip, total: ITEMS.length };
}

function proofsReady() {
    return ITEMS.filter((it) => it.group === 'proof').every((it) => {
        const s = results[it.id]?.status;
        return s === 'pass' || s === 'skip';
    }) && ITEMS.filter((it) => it.group === 'proof').some((it) => results[it.id]?.status === 'pass');
}

function paintHeader() {
    const el = document.getElementById('cp10s-progress');
    if (!el) return;
    const { pass, failN, skip, total } = counts();
    el.textContent = `${pass} pass / ${failN} fail / ${skip} skip / ${total}`;
    const banner = document.getElementById('cp10s-banner');
    if (!banner) return;
    if (proofsReady()) {
        banner.hidden = false;
        banner.textContent = 'Proofs recorded. Full kit still required. Do not start CP11 from a session that removed nodes — hard refresh first.';
    } else {
        banner.hidden = true;
    }
}

function paintItem(id) {
    const row = document.querySelector(`[data-cp10-id="${id}"]`);
    if (!row) return;
    const rec = results[id];
    row.dataset.status = rec?.status || 'pending';
    const st = row.querySelector('.cp10s-status');
    if (st) st.textContent = rec?.status || 'pending';
    const det = row.querySelector('.cp10s-detail');
    if (det) det.textContent = rec?.detail || itemById(id)?.hint || '';
}

function reportText() {
    const lines = ITEMS.map((it) => {
        const rec = results[it.id];
        return `${it.id}\t${rec?.status || 'pending'}\t${rec?.detail || ''}`;
    });
    return `CP10 smoke ${new Date().toISOString()}\n${lines.join('\n')}`;
}

async function handleRun(id) {
    const fn = RUNNERS[id];
    if (!fn) return;
    try {
        const result = await fn();
        setStatus(id, result.ok ? 'pass' : 'fail', result.detail);
    } catch (err) {
        setStatus(id, 'fail', err?.message || String(err));
    }
}

function injectStyle() {
    if (document.getElementById('cp10s-style')) return;
    const style = document.createElement('style');
    style.id = 'cp10s-style';
    style.textContent = `
#${PANEL_ID}{position:fixed;top:8px;right:8px;z-index:2147483000;width:340px;max-height:calc(100vh - 16px);
  display:flex;flex-direction:column;background:#050805;color:#b6e0b6;border:1px solid #1f7a1f;
  font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.01em}
#${PANEL_ID}.is-min{width:auto;max-height:none}
#${PANEL_ID} header{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #143d14;
  background:#081208;cursor:default}
#${PANEL_ID} header strong{color:#7dff7d;font-weight:600}
#cp10s-progress{margin-left:auto;color:#8cb88c}
#${PANEL_ID} .cp10s-btn{background:#081208;color:#7dff7d;border:1px solid #1f7a1f;padding:1px 6px;font:inherit;cursor:pointer}
#${PANEL_ID} .cp10s-btn:hover{background:#0c1c0c}
#${PANEL_ID} .cp10s-body{overflow:auto;padding:6px 8px 8px}
#${PANEL_ID}.is-min .cp10s-body,#${PANEL_ID}.is-min #cp10s-banner{display:none}
#cp10s-banner{margin:6px 8px 0;padding:6px;border:1px solid #7dff7d;color:#7dff7d}
#${PANEL_ID} h2{margin:10px 0 4px;font-size:10px;text-transform:uppercase;color:#5a9a5a;letter-spacing:.08em}
#${PANEL_ID} .cp10s-row{border-top:1px solid #102410;padding:5px 0}
#${PANEL_ID} .cp10s-row[data-status="pass"] .cp10s-status{color:#7dff7d}
#${PANEL_ID} .cp10s-row[data-status="fail"] .cp10s-status{color:#ff6b6b}
#${PANEL_ID} .cp10s-row[data-status="skip"] .cp10s-status{color:#8a8a8a}
#${PANEL_ID} .cp10s-top{display:flex;gap:6px;align-items:baseline}
#${PANEL_ID} .cp10s-title{flex:1}
#${PANEL_ID} .cp10s-status{text-transform:uppercase;font-size:9px}
#${PANEL_ID} .cp10s-actions{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}
#${PANEL_ID} .cp10s-detail{color:#6e9a6e;white-space:normal}
#cp10s-log{margin-top:8px;max-height:90px;overflow:auto;border-top:1px solid #102410;padding-top:4px;color:#6e9a6e}
#${PANEL_ID} .cp10s-note{color:#6e9a6e;margin:0 0 6px}
`;
    document.head.appendChild(style);
}

function render() {
    injectStyle();
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-label', 'CP10 smoke tracker');

    const header = document.createElement('header');
    header.innerHTML = '<strong>CP10 smoke</strong><span id="cp10s-progress"></span>';
    const minBtn = document.createElement('button');
    minBtn.type = 'button';
    minBtn.className = 'cp10s-btn';
    minBtn.textContent = 'min';
    minBtn.addEventListener('click', () => {
        panel.classList.toggle('is-min');
        minBtn.textContent = panel.classList.contains('is-min') ? 'open' : 'min';
    });
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cp10s-btn';
    copyBtn.textContent = 'copy';
    copyBtn.addEventListener('click', async () => {
        const text = reportText();
        try {
            await navigator.clipboard.writeText(text);
            logLine('Report copied');
        } catch {
            console.log(text);
            logLine('Report logged to console');
        }
    });
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'cp10s-btn';
    resetBtn.textContent = 'reset';
    resetBtn.addEventListener('click', () => {
        results = {};
        saveResults();
        ITEMS.forEach((it) => paintItem(it.id));
        paintHeader();
        logLine('Reset tracker (page nodes are not restored — hard refresh)');
    });
    header.append(minBtn, copyBtn, resetBtn);
    panel.appendChild(header);

    const banner = document.createElement('div');
    banner.id = 'cp10s-banner';
    banner.hidden = true;
    panel.appendChild(banner);

    const body = document.createElement('div');
    body.className = 'cp10s-body';
    const note = document.createElement('p');
    note.className = 'cp10s-note';
    note.textContent = 'Ghost HTML stays. Proofs 2–6 remove classic nodes. Hard refresh before CP11. Hardware MIDI CC and CP9 audio niggles are not fails.';
    body.appendChild(note);

    GROUPS.forEach((group) => {
        const h = document.createElement('h2');
        h.textContent = group.label;
        body.appendChild(h);
        ITEMS.filter((it) => it.group === group.id).forEach((it) => {
            const row = document.createElement('div');
            row.className = 'cp10s-row';
            row.dataset.cp10Id = it.id;
            row.dataset.status = results[it.id]?.status || 'pending';

            const top = document.createElement('div');
            top.className = 'cp10s-top';
            const title = document.createElement('div');
            title.className = 'cp10s-title';
            title.textContent = it.title;
            const status = document.createElement('div');
            status.className = 'cp10s-status';
            status.textContent = results[it.id]?.status || 'pending';
            top.append(title, status);
            row.appendChild(top);

            const actions = document.createElement('div');
            actions.className = 'cp10s-actions';
            const add = (label, fn) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'cp10s-btn';
                b.textContent = label;
                b.addEventListener('click', fn);
                actions.appendChild(b);
            };
            if (it.kind === 'run') add('Run', () => handleRun(it.id));
            if (it.kind === 'watch') {
                add('Arm', () => {
                    const result = armRecWatch();
                    if (result.ok) logLine(result.detail);
                    else setStatus(it.id, 'fail', result.detail);
                });
                add('Score', () => {
                    const result = scoreRecWatch();
                    setStatus(it.id, result.ok ? 'pass' : 'fail', result.detail);
                });
            }
            add('Pass', () => setStatus(it.id, 'pass', 'marked'));
            add('Fail', () => setStatus(it.id, 'fail', 'marked'));
            add('Skip', () => setStatus(it.id, 'skip', 'marked'));
            row.appendChild(actions);

            const detail = document.createElement('div');
            detail.className = 'cp10s-detail';
            detail.textContent = results[it.id]?.detail || it.hint || '';
            row.appendChild(detail);
            body.appendChild(row);
        });
    });

    logEl = document.createElement('div');
    logEl.id = 'cp10s-log';
    body.appendChild(logEl);
    panel.appendChild(body);
    document.body.appendChild(panel);
    paintHeader();
}

export function initCp10Smoke() {
    render();
    window.cp10Smoke = {
        pass: (id, detail) => setStatus(id, 'pass', detail || 'console'),
        fail: (id, detail) => setStatus(id, 'fail', detail || 'console'),
        skip: (id, detail) => setStatus(id, 'skip', detail || 'console'),
        run: handleRun,
        report: reportText,
        reset() {
            results = {};
            saveResults();
            ITEMS.forEach((it) => paintItem(it.id));
            paintHeader();
        },
    };
    logLine('Tracker ready. window.cp10Smoke.report() copies the same list.');
}
