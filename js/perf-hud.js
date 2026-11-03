// Live CPU / audio-thread overlay. On by default; hide with ?perf=0.
// The overlay's hide/show button collapses the readout; the choice is remembered.
// "keep" / "hw" are audio-seconds / wall-seconds over the last 1s (~1.00 = keeping up).

import { state } from './state.js?v=120';
import { getWorkletPoolStats } from './osc-source.js?v=135';

function el(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
}

function prof() {
    return (window.__ingyProf ||= {
        scopeMax: 0, seqMax: 0, hudMax: 0, frameMax: 0,
        analogMax: 0, analogN: 0, workletCreateMax: 0, workletCreateN: 0,
        domMax: 0, domN: 0,
        analogShellMissN: 0, refillMaxMs: 0, refillN: 0, refillMadeMax: 0,
    });
}

export function initPerfHud() {
    const q = new URLSearchParams(location.search);
    if (q.get('scope') === '0') {
        const pOff = prof();
        pOff.scopeVisible = false;
        pOff.scopeGlow = false;
    }
    if (q.get('perf') === '0') return;

    const box = el('div', [
        'position:fixed',
        'left:8px',
        'bottom:8px',
        'z-index:99999',
        'font:12px/1.35 ui-monospace,Menlo,monospace',
        'background:rgba(0,0,0,0.82)',
        'color:#c8ffc8',
        'padding:10px 12px',
        'border:1px solid #2f6',
        'border-radius:6px',
        'min-width:300px',
        'pointer-events:none',
        'white-space:pre',
    ].join(';'));
    box.id = 'ingyPerfHud';

    const head = el('div', [
        'display:flex',
        'align-items:center',
        'justify-content:space-between',
        'gap:12px',
        'margin-bottom:2px',
        'pointer-events:none',
        'white-space:nowrap',
    ].join(';'));
    const title = el('span', '', 'INGY PERF');
    const btn = el('button', [
        'font:inherit',
        'line-height:1',
        'color:inherit',
        'background:transparent',
        'border:1px solid currentColor',
        'border-radius:3px',
        'padding:1px 6px',
        'cursor:pointer',
        'pointer-events:auto',
    ].join(';'));
    btn.type = 'button';
    const body = el('div');
    body.id = 'ingyPerfHudBody';
    head.append(title, btn);
    box.append(head, body);
    document.body.appendChild(box);

    const VIS_KEY = 'ingyPerfHudVisible';
    let visible = true;
    try {
        visible = localStorage.getItem(VIS_KEY) !== '0';
    } catch (_) { /* private mode */ }

    function applyVisible() {
        body.hidden = !visible;
        head.style.marginBottom = visible ? '2px' : '0';
        box.style.minWidth = visible ? '300px' : '0';
        btn.textContent = visible ? 'hide' : 'show';
        btn.setAttribute('aria-expanded', visible ? 'true' : 'false');
        btn.setAttribute('aria-controls', 'ingyPerfHudBody');
        btn.setAttribute('aria-label', visible ? 'Hide performance window' : 'Show performance window');
    }

    function setVisible(on) {
        visible = !!on;
        try {
            localStorage.setItem(VIS_KEY, visible ? '1' : '0');
        } catch (_) { /* private mode */ }
        applyVisible();
        if (visible) paint(snapshot());
    }

    btn.addEventListener('click', () => setVisible(!visible));
    applyVisible();

    let frames = 0;
    let fps = 0;
    let fpsT0 = performance.now();
    let winWall0 = null;
    let winAudio0 = null;
    let keepUp1s = 1;
    let dLagMs = 0;
    let keepHw = null;
    let staleMs = 0;
    let hasTs = false;
    let tsWin0 = null;
    let stalls = 0;
    let longTasks = 0;
    let longTaskMs = 0;
    let lastRaf = 0;

    try {
        const obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                longTasks += 1;
                longTaskMs += e.duration || 0;
            }
        });
        obs.observe({ type: 'longtask', buffered: true });
    } catch (_) { /* Safari / unsupported */ }

    function snapshot() {
        const ctx = state.audioContext;
        const pool = getWorkletPoolStats();
        const drums = Array.isArray(state.berlinDrumVoices) ? state.berlinDrumVoices : [];
        const p = prof();
        const liveOsc = (state.activeOscillators || []).filter((o) => o?.started).length;
        const polyMode = state.keyboardPoly ? 'poly' : state.keyboardMultitudes ? 'multitudes' : 'mono';
        return {
            fps,
            keepUp1s,
            dLagMs,
            keepHw,
            staleMs,
            hasTs,
            stalls,
            ctxState: ctx?.state || 'none',
            playing: !!state.isPlaying,
            phaseReset: !!state.phaseResetEnabled,
            unisonOn: !!state.unisonEnabled,
            unisonVoices: state.unisonVoices,
            osc4Wavetable: !!state.osc4Wavetable,
            osc4Model: state.osc4Model || null,
            polyMode,
            acid: !!state.acidMode,
            liveOsc,
            wtPool: pool?.wt,
            drumPool: pool?.drum,
            analogShells: pool?.analogShells || 0,
            analogShellTarget: pool?.analogShellTarget || 0,
            analogDrums: drums.length,
            analogHats: drums.filter((v) => v?.model === 'hihat' || v?.model === 'open_hat').length,
            berlinMode: !!state.berlinMode,
            berlinOsc: Array.isArray(state.berlinOscVoices) ? state.berlinOscVoices.length : 0,
            longTasks,
            longTaskMs: Math.round(longTaskMs),
            scopeMaxMs: Math.round((p.scopeMax || 0) * 10) / 10,
            scopeVisible: !!p.scopeVisible,
            scopeGlow: !!p.scopeGlow,
            scopeRafN: p.scopeRafN || 0,
            scopePaintN: p.scopePaintN || 0,
            hudRafN: p.hudRafN || 0,
            canvasW: document.getElementById('kbOscilloscope')?.width || 0,
            canvasH: document.getElementById('kbOscilloscope')?.height || 0,
            fftBins: state.analyser?.frequencyBinCount || 0,
            vfdMaxMs: Math.round((p.vfdMax || 0) * 10) / 10,
            vfdN: p.vfdN || 0,
            dispMaxMs: Math.round((p.dispMax || 0) * 10) / 10,
            dispN: p.dispN || 0,
            seqMaxMs: Math.round((p.seqMax || 0) * 10) / 10,
            hudMaxMs: Math.round((p.hudMax || 0) * 10) / 10,
            frameMaxMs: Math.round((p.frameMax || 0) * 10) / 10,
            analogMaxMs: Math.round((p.analogMax || 0) * 10) / 10,
            analogN: p.analogN || 0,
            analogOscCreateMaxMs: Math.round((p.analogOscCreateMax || 0) * 10) / 10,
            analogOscCreateN: p.analogOscCreateN || 0,
            analogOscStartMaxMs: Math.round((p.analogOscStartMax || 0) * 10) / 10,
            analogOscStartN: p.analogOscStartN || 0,
            analogShellMissN: p.analogShellMissN || 0,
            analogGainCreateN: p.analogGainCreateN || 0,
            analogDisconnectN: p.analogDisconnectN || 0,
            analogDisconnectMaxMs: Math.round((p.analogDisconnectMax || 0) * 10) / 10,
            analogReuseN: p.analogReuseN || 0,
            analogGainCreateN: p.analogGainCreateN || 0,
            refillMaxMs: Math.round((p.refillMaxMs || 0) * 10) / 10,
            refillN: p.refillN || 0,
            refillMadeMax: p.refillMadeMax || 0,
            analogAbx: p.analogAbx || null,
            workletCreateMaxMs: Math.round((p.workletCreateMax || 0) * 10) / 10,
            workletCreateN: p.workletCreateN || 0,
            domMaxMs: Math.round((p.domMax || 0) * 10) / 10,
            domN: p.domN || 0,
        };
    }

    function paint(s) {
        const meter = s.hasTs && s.keepHw != null ? s.keepHw : s.keepUp1s;
        const behind = meter < 0.95 || s.stalls > 0;
        box.style.color = behind ? '#ffb0b0' : '#c8ffc8';
        box.style.borderColor = behind ? '#f66' : '#2f6';
        const keep = Number.isFinite(s.keepUp1s) ? s.keepUp1s.toFixed(3) : '—';
        const hw = s.keepHw != null ? s.keepHw.toFixed(3) : '—';
        const dLag = `${s.dLagMs >= 0 ? '+' : ''}${s.dLagMs.toFixed(1)}ms`;
        body.textContent = [
            `fps ${s.fps.toFixed(0).padStart(3)}   rAF ${keep}×  hw ${hw}×`,
            `rAF ${dLag}  stale ${s.staleMs.toFixed(0)}ms  stalls ${s.stalls}`,
            `ctx ${s.ctxState}  play ${s.playing ? 'on' : 'off'}  ${s.osc4Wavetable ? s.osc4Model : 'analog'} ${s.polyMode}${s.acid ? ' acid' : ''} uni ${s.unisonOn ? s.unisonVoices : 'off'}`,
            `wt pool ${s.wtPool?.inUse || 0}/${s.wtPool?.size || 0}  drum ${s.drumPool?.inUse || 0}/${s.drumPool?.size || 0}${s.drumPool?.overflow ? ' OVER' : ''}  sh ${s.analogShells}/${s.analogShellTarget}`,
            `live osc ${s.liveOsc}  berlin ${s.berlinMode ? 'on' : 'off'} osc ${s.berlinOsc} drums ${s.analogDrums} (hats ${s.analogHats})`,
            `scope ${s.scopeVisible ? s.scopeMaxMs : 'off'}ms raf ${s.scopeRafN}  seq ${s.seqMaxMs}ms  hud ${s.hudMaxMs}ms  gap ${s.frameMaxMs}ms`,
            `vfd ${s.vfdMaxMs}ms×${s.vfdN}  disp ${s.dispMaxMs}ms×${s.dispN}  dom ${s.domMaxMs}ms×${s.domN}`,
            `analog ${s.analogMaxMs}ms×${s.analogN}  wtNew ${s.workletCreateMaxMs}ms×${s.workletCreateN}`,
            `oscC ${s.analogOscCreateMaxMs}ms×${s.analogOscCreateN}  oscS ${s.analogOscStartMaxMs}ms×${s.analogOscStartN}${s.analogAbx ? `  abx c${s.analogAbx.createMs}/s${s.analogAbx.startMs}/p${s.analogAbx.poolStartMs}` : ''}`,
            `long tasks ${s.longTasks} (${s.longTaskMs}ms)`,
        ].join('\n');
    }

    let lastPaint = 0;
    const PAINT_EVERY_MS = 250;

    function tick(now) {
        frames += 1;
        const p = prof();
        p.hudRafN = (p.hudRafN || 0) + 1;
        if (lastRaf) {
            const dt = now - lastRaf;
            if (dt > p.frameMax) p.frameMax = dt;
        }
        lastRaf = now;
        if (now - fpsT0 >= 1000) {
            fps = frames * 1000 / (now - fpsT0);
            frames = 0;
            fpsT0 = now;
        }
        const ctx = state.audioContext;
        if (ctx && ctx.state === 'running') {
            const audio = ctx.currentTime;
            let ts = null;
            try {
                if (typeof ctx.getOutputTimestamp === 'function') ts = ctx.getOutputTimestamp();
            } catch (_) { ts = null; }
            hasTs = !!(ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime));
            if (hasTs) staleMs = now - ts.performanceTime;
            if (winWall0 == null) {
                winWall0 = now / 1000;
                winAudio0 = audio;
                tsWin0 = hasTs ? ts : null;
            } else if (now / 1000 - winWall0 >= 1) {
                const wallDt = now / 1000 - winWall0;
                const audioDt = audio - winAudio0;
                keepUp1s = wallDt > 0 ? audioDt / wallDt : 1;
                dLagMs = (wallDt - audioDt) * 1000;
                if (audioDt < 0.5) stalls += 1;
                if (hasTs && tsWin0) {
                    const hwWall = (ts.performanceTime - tsWin0.performanceTime) / 1000;
                    const hwAudio = ts.contextTime - tsWin0.contextTime;
                    keepHw = hwWall > 0 ? hwAudio / hwWall : null;
                } else {
                    keepHw = null;
                }
                winWall0 = now / 1000;
                winAudio0 = audio;
                tsWin0 = hasTs ? ts : null;
                p.scopeMax = 0;
                p.scopeRafN = 0;
                p.scopePaintN = 0;
                p.hudRafN = 0;
                p.seqMax = 0;
                p.hudMax = 0;
                p.frameMax = 0;
                p.analogMax = 0;
                p.analogN = 0;
                p.domMax = 0;
                p.domN = 0;
                p.vfdMax = 0;
                p.vfdN = 0;
                p.dispMax = 0;
                p.dispN = 0;
                p.workletCreateMax = 0;
                p.workletCreateN = 0;
                p.analogOscCreateMax = 0;
                p.analogOscCreateN = 0;
                p.analogOscStartMax = 0;
                p.analogOscStartN = 0;
                p.analogShellMissN = 0;
                p.analogGainCreateN = 0;
                p.analogDisconnectN = 0;
                p.analogDisconnectMax = 0;
                p.analogReuseN = 0;
                p.analogGainCreateN = 0;
                p.refillMaxMs = 0;
                p.refillN = 0;
                p.refillMadeMax = 0;
            }
        }
        if (visible && now - lastPaint >= PAINT_EVERY_MS) {
            lastPaint = now;
            const hudT0 = performance.now();
            paint(snapshot());
            const hudMs = performance.now() - hudT0;
            p.hudMs = hudMs;
            if (hudMs > p.hudMax) p.hudMax = hudMs;
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}
