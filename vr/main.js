import { createScene } from './scene.js?v=29';
import { bindBoard } from './keyboard.js?v=249';
import { createPoly800, placeOnDesk } from './poly800.js?v=29';
import { DESK_TOP_Y, KEYBOARD_Z } from './loft.js?v=22';
import { createDeskMonitors, liveDisplayDown, liveDisplayUp } from './screens.js?v=25';
import { createTolomeoLamps } from './tolomeo.js?v=12';
import { attachHexPaint } from './hex-scope.js?v=11';
import { closeSelect } from './vr-select.js?v=2';
import { attachXrInput } from './xr-input.js?v=7';

const statusEl = document.getElementById('status');
const enterVrBtn = document.getElementById('enterVr');
const testNoteBtn = document.getElementById('testNote');

function setStatus(msg) {
    statusEl.textContent = msg;
}

let initAudio = () => {};
let pressKey = () => {};
let releaseKey = () => {};
let heldNoteDown = () => {};
let heldNoteUp = () => {};
let needsHeldNoteSet = () => false;
let applyPitchBend = () => {};
let getBendRangeSemitones = () => 2;
let setLfoAmount = () => {};
let togglePlay = () => {};
let setParam = () => {};
let toggleParam = () => {};
let getNumber = () => 0;
let getParamValue = () => false;
let subscribeParam = () => () => {};
let setAcidMode = () => {};
let toggleBerlinMode = () => {};
let togglePolyMode = () => {};
let toggleMultitudesMode = () => {};
let toggleKeyboardArp = () => {};
let toggleKeyboardArpChord = () => {};
let cycleArpOrder = () => {};
let arpOrderLabel = () => 'Up';
let applyScaleState = () => {};
let isInActiveScale = () => true;
let setFilterEnvInvert = () => {};
let engineState = { acidMode: false, berlinMode: false, keyboardPoly: false, keyboardMultitudes: false };
let engineReady = false;

function lfoHasDestination() {
    return Math.abs(getNumber('cutoffMod', 0)) > 1
        || Math.abs(getNumber('osc1PitchMod', 0)) > 0.05
        || Math.abs(getNumber('osc2PitchMod', 0)) > 0.05
        || Math.abs(getNumber('osc3PitchMod', 0)) > 0.05
        || Math.abs(getNumber('osc4PitchMod', 0)) > 0.05;
}

function modeFlags() {
    return {
        acid: !!engineState.acidMode,
        berlin: !!engineState.berlinMode,
        poly: !!engineState.keyboardPoly,
        multitudes: !!engineState.keyboardMultitudes,
    };
}

async function bootEngine() {
    setStatus('Loading INGYSYNTH engine…');
    const ae = await import('../js/audio-engine.js?v=219');
    const kb = await import('../js/keyboard.js?v=249');
    const held = await import('../js/held-notes.js?v=10');
    const bend = await import('../js/pitch-bend.js?v=115');
    const lfo = await import('../js/lfo-strip.js?v=44');
    const seq = await import('../js/sequencer.js?v=428');
    const params = await import('../js/params.js?v=19');
    const acid = await import('../js/controls.js?v=340');
    const berlin = await import('../js/berlin.js?v=94');
    const polyVoice = await import('../js/poly-voice.js?v=164');
    const mult = await import('../js/keyboard-multitudes-panel.js?v=59');
    const st = await import('../js/state.js?v=118');
    const filtEnv = await import('../js/keyboard-filter-env.js?v=107');
    initAudio = ae.initAudio;
    pressKey = kb.pressKey;
    releaseKey = kb.releaseKey;
    heldNoteDown = kb.heldNoteDown;
    heldNoteUp = kb.heldNoteUp;
    needsHeldNoteSet = held.needsHeldNoteSet;
    applyPitchBend = bend.applyPitchBend;
    getBendRangeSemitones = bend.getBendRangeSemitones;
    setLfoAmount = lfo.setLfoAmount;
    togglePlay = seq.togglePlay;
    setParam = params.set;
    toggleParam = params.toggle;
    getNumber = params.getNumber;
    getParamValue = params.get;
    subscribeParam = params.subscribe;
    setAcidMode = acid.setAcidMode;
    toggleBerlinMode = berlin.toggleBerlinMode;
    togglePolyMode = polyVoice.togglePolyMode;
    toggleMultitudesMode = mult.toggleMultitudesMode;
    toggleKeyboardArp = kb.toggleKeyboardArp;
    toggleKeyboardArpChord = kb.toggleKeyboardArpChord;
    cycleArpOrder = kb.cycleArpOrder;
    arpOrderLabel = kb.arpOrderLabel;
    applyScaleState = kb.applyScaleState;
    isInActiveScale = kb.isInActiveScale;
    setFilterEnvInvert = filtEnv.setFilterEnvInvert;
    engineState = st.state;
    try { polyVoice.initPolyVoice(); } catch (_) { /* no 2D panel */ }
    try { mult.initMultitudesPanel(); } catch (_) { /* no 2D panel */ }
    try { berlin.initBerlin(); } catch (_) { /* no 2D panel */ }
    engineReady = true;
}

async function boot() {
    try {
        await bootEngine();
        testNoteBtn.disabled = false;
    } catch (err) {
        setStatus('Engine failed to load: ' + (err && err.message ? err.message : String(err)));
        console.error(err);
        return;
    }

    const { renderer, scene, camera, onFrame } = createScene(document.body);
    const poly = createPoly800();
    placeOnDesk(poly.board, { topY: DESK_TOP_Y, z: KEYBOARD_Z });
    scene.add(poly.board);
    createDeskMonitors(scene, onFrame, poly.interactives);
    createTolomeoLamps(scene, poly.interactives);
    attachHexPaint(onFrame, poly.hex, () => engineState.analyser);

    let testMesh = null;
    let testTimer = 0;

    function syncPanel() {
        closeSelect(poly.interactives);
        poly.syncSpecials(engineState, arpOrderLabel());
        poly.setModeLamps(modeFlags());
    }

    function syncScaleKeys() {
        poly.applyScaleFilter((semi) => isInActiveScale(semi));
    }

    function notePress(semi) {
        if (!engineReady) return;
        if (!isInActiveScale(semi)) return;
        initAudio();
        liveDisplayUp();
        liveDisplayDown(semi);
        pressKey(semi);
    }

    function noteRelease() {
        if (!engineReady) return;
        liveDisplayUp();
        releaseKey();
        if (testMesh) {
            poly.setPressed(testMesh, false);
            testMesh = null;
        }
    }

    const { controllers, releaseAll } = bindBoard({
        renderer,
        scene,
        camera,
        onFrame,
        interactives: poly.interactives,
        keyMeshes: poly.keyMeshes,
        setPressed: poly.setPressed,
        setKeyHover: poly.setKeyHover,
        shiftOctave: poly.shiftOctave,
        useHeld: () => needsHeldNoteSet(),
        onPress: notePress,
        onRelease: noteRelease,
        onHeldDown: (semi) => {
            if (!engineReady) return;
            if (!isInActiveScale(semi)) return;
            initAudio();
            liveDisplayDown(semi);
            heldNoteDown(semi);
        },
        onHeldUp: (semi) => {
            if (!engineReady) return;
            liveDisplayUp(semi);
            heldNoteUp(semi);
        },
        onAnySelect: () => {
            if (engineReady) initAudio();
        },
        onStartStop: () => {
            if (!engineReady) return;
            initAudio();
            togglePlay();
        },
        onMode: (mode) => {
            if (!engineReady) return;
            initAudio();
            if (mode === 'acid') setAcidMode(!engineState.acidMode);
            else if (mode === 'berlin') toggleBerlinMode();
            else if (mode === 'poly') togglePolyMode();
            else if (mode === 'multitudes') toggleMultitudesMode();
            syncPanel();
        },
        onPitch: (norm) => {
            if (!engineReady) return;
            initAudio();
            poly.setPitchNorm(norm);
            applyPitchBend(norm * getBendRangeSemitones());
        },
        onPitchEnd: () => {
            poly.setPitchNorm(0);
            applyPitchBend(0, { ramp: 0.04 });
        },
        onLfo: (norm) => {
            if (!engineReady) return;
            initAudio();
            if (norm > 0.02 && !lfoHasDestination()) setParam('cutoffMod', 900);
            poly.setLfoNorm(norm);
            setLfoAmount(norm, { mode: 'drag' });
        },
        onKnob: (key, value) => {
            if (!engineReady) return;
            initAudio();
            setParam(key, value);
            if (key === 'scaleSelect') applyScaleState(undefined, value);
        },
        onButton: (ud) => {
            if (!engineReady) return;
            initAudio();
            if (ud.special === 'arp') toggleKeyboardArp();
            else if (ud.special === 'arpChord') toggleKeyboardArpChord();
            else if (ud.special === 'arpOrder') cycleArpOrder();
            else if (ud.special === 'reverse') {
                engineState.isReverse = !engineState.isReverse;
                if (engineState.isPlaying || engineState.isArping) {
                    engineState.currentStep = engineState.isReverse
                        ? Math.max(0, getNumber('stepCount', 8) - 1)
                        : 0;
                }
            } else if (ud.special === 'invert') {
                setFilterEnvInvert(!engineState.filterEnvInvert);
            } else if (ud.radioValue != null && ud.key) {
                setParam(ud.key, ud.radioValue);
            } else if (ud.key) {
                toggleParam(ud.key);
                if (ud.key === 'scaleToggle') applyScaleState(!!getParamValue('scaleToggle'));
            }
            poly.syncSpecials(engineState, arpOrderLabel());
        },
    });
    attachXrInput({ renderer, scene, onFrame, controllers });

    subscribeParam('scaleSelect', (v) => applyScaleState(undefined, v));
    subscribeParam('scaleToggle', () => syncScaleKeys());
    document.addEventListener('ingysynth:keyboard-pitch-ui', syncScaleKeys);
    syncScaleKeys();
    poly.syncSpecials(engineState, arpOrderLabel());

    document.addEventListener('ingysynth:sequencer-start', () => poly.setPlaying(true));
    document.addEventListener('ingysynth:sequencer-stop', () => poly.setPlaying(false));
    document.addEventListener('ingysynth:berlin-mode', () => syncPanel());

    renderer.xr.addEventListener('sessionstart', () => {
        document.body.classList.add('xr-presenting');
        if (engineReady) initAudio();
    });
    renderer.xr.addEventListener('sessionend', () => {
        document.body.classList.remove('xr-presenting');
        releaseAll();
        noteRelease();
        setStatus('Headset session ended. Enter VR to go back in.');
    });

    let xrOk = false;
    if (navigator.xr && typeof navigator.xr.isSessionSupported === 'function') {
        try {
            xrOk = await navigator.xr.isSessionSupported('immersive-vr');
        } catch (_) {
            xrOk = false;
        }
    }
    enterVrBtn.disabled = !xrOk;
    if (!xrOk) {
        setStatus('Engine ready. WebXR is off here — on the Quest open http://localhost:8000/vr/');
    } else {
        setStatus('Engine ready. Sit, Enter VR. Main Stage is the slanted heart; modes stay on the key deck.');
    }

    enterVrBtn.addEventListener('click', async () => {
        try {
            initAudio();
            let session;
            try {
                session = await navigator.xr.requestSession('immersive-vr', {
                    requiredFeatures: ['local-floor'],
                    optionalFeatures: ['hand-tracking'],
                });
            } catch (_) {
                session = await navigator.xr.requestSession('immersive-vr', {
                    optionalFeatures: ['local-floor', 'hand-tracking'],
                });
            }
            await renderer.xr.setSession(session);
        } catch (err) {
            setStatus('Enter VR failed: ' + (err && err.message ? err.message : String(err)));
            console.error(err);
        }
    });

    testNoteBtn.addEventListener('click', () => {
        notePress(0);
        if (testMesh) poly.setPressed(testMesh, false);
        testMesh = poly.meshForSemi(0);
        if (testMesh) poly.setPressed(testMesh, true);
        clearTimeout(testTimer);
        testTimer = window.setTimeout(noteRelease, 450);
    });
}

boot();
