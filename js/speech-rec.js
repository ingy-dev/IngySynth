// Voice REC modal: mic capture → local LPC encode → USER bank inject.

import { state } from './state.js?v=116';
import {
    applySpeechUserBankToLive,
    clearSpeechUserBank,
    hasSpeechUserBank,
    getSpeechUserBankBytes,
    setSpeechUserBankActive,
} from './osc-source.js?v=125';
import {
    SPEECH_LPC_MAX_SEC,
    SPEECH_LPC_MAX_FRAMES,
    SPEECH_LPC_SR,
    decodeBlobToMono,
    encodeRecordingToUserBank,
    inspectUserBank,
    renderLpcPreview,
} from './speech-lpc-encoder.js?v=8';

const SPEECH_USER_META_KEY = 'ingysynth.speechUserBankMeta.v1';

let mediaRecorder = null;
let mediaStream = null;
let recordedChunks = [];
let recordingTimer = null;
let encoding = false;
/** Optional hook from controls to refresh HARMONICS labels after USER load/clear. */
let onUserBankUiChange = null;

let lastMeta = null;
let lastSource8k = null;
let previewNode = null;
let previewMode = null;
const previewCache = { natural: null, flat: null };

export function setSpeechUserBankUiHook(fn) {
    onUserBankUiChange = typeof fn === 'function' ? fn : null;
}

function notifyUserBankUiChange() {
    try { onUserBankUiChange?.(); } catch (_) { /* ignore */ }
}

function $(id) {
    return document.getElementById(id);
}

function setStatus(msg) {
    const el = $('speechRecStatus');
    if (el) el.textContent = msg || '';
}

function setProgress(frac, visible) {
    const wrap = document.querySelector('.speech-rec-modal__progress');
    const bar = $('speechRecProgressBar');
    if (wrap) wrap.hidden = !visible;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (frac || 0) * 100))}%`;
}

function loadMeta() {
    try {
        const raw = localStorage.getItem(SPEECH_USER_META_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

function saveMeta(meta) {
    lastMeta = meta;
    try {
        if (meta) localStorage.setItem(SPEECH_USER_META_KEY, JSON.stringify(meta));
        else localStorage.removeItem(SPEECH_USER_META_KEY);
    } catch (_) { /* quota */ }
}

function formatStats({ wordCount, durationSec, byteLength, gainDb }) {
    const parts = [`${wordCount} word${wordCount === 1 ? '' : 's'}`];
    if (durationSec != null && Number.isFinite(durationSec)) {
        parts.push(`${durationSec.toFixed(2)} s`);
    }
    if (byteLength != null) {
        parts.push(`${(byteLength / 1024).toFixed(1)} KB`);
    }
    if (gainDb != null && Number.isFinite(gainDb) && Math.abs(gainDb) >= 0.05) {
        const sign = gainDb >= 0 ? '+' : '';
        parts.push(`level matched ${sign}${gainDb.toFixed(1)} dB`);
    }
    return parts.join(' — ');
}

function hideReady() {
    const ready = $('speechRecReady');
    if (ready) ready.hidden = true;
}

function showReady(meta) {
    const ready = $('speechRecReady');
    if (!ready) return;
    ready.hidden = false;
    const stats = $('speechRecReadyStats');
    if (stats) stats.textContent = formatStats(meta);
    const frames = Math.max(0, meta.frameCount | 0);
    const max = SPEECH_LPC_MAX_FRAMES;
    const left = Math.max(0, max - frames);
    const label = $('speechRecFrameLabel');
    if (label) label.textContent = `${frames.toLocaleString()} / ${max.toLocaleString()}`;
    const leftEl = $('speechRecFrameLeft');
    if (leftEl) leftEl.textContent = `${left.toLocaleString()} left`;
    const bar = $('speechRecFrameBar');
    if (bar) {
        bar.style.width = `${Math.max(0, Math.min(100, (frames / max) * 100))}%`;
        bar.classList.toggle('is-hot', frames / max >= 0.85);
    }
    const srcBtn = $('speechRecPreviewSource');
    if (srcBtn) srcBtn.disabled = !(lastSource8k && lastSource8k.length);
}

function refreshReadyFromBank() {
    const bytes = getSpeechUserBankBytes();
    if (!bytes || !bytes.length) {
        hideReady();
        lastMeta = null;
        return;
    }
    const inspected = inspectUserBank(bytes);
    const stored = lastMeta || loadMeta() || {};
    lastMeta = {
        wordCount: inspected.wordCount || stored.wordCount || 0,
        frameCount: inspected.frameCount || stored.frameCount || 0,
        durationSec: stored.durationSec,
        gainDb: stored.gainDb,
        byteLength: bytes.length,
    };
    showReady(lastMeta);
}

export function syncSpeechRecUi() {
    const show = !!state.osc4Wavetable && state.osc4Model === 'speech';
    const hasBank = hasSpeechUserBank();
    const userOn = !!state.osc4SpeechUserBank && hasBank;
    const isRecording = !!(mediaRecorder && mediaRecorder.state === 'recording');

    document.querySelectorAll('.osc4-speech-rec-row').forEach((row) => {
        row.hidden = !show;
    });

    document.querySelectorAll('.osc4-speech-rec-btn').forEach((btn) => {
        btn.classList.toggle('off', !isRecording);
        btn.setAttribute('aria-pressed', isRecording ? 'true' : 'false');
        btn.title = isRecording
            ? 'Recording… open panel to Stop'
            : 'Record a Voice user bank';
    });

    document.querySelectorAll('.osc4-speech-user-btn').forEach((btn) => {
        btn.disabled = !hasBank;
        btn.classList.toggle('off', !userOn);
        btn.setAttribute('aria-pressed', userOn ? 'true' : 'false');
        btn.title = !hasBank
            ? 'No USER bank yet — record one first'
            : (userOn
                ? 'USER bank on — click for factory Voice'
                : 'USER bank stored — click to use it');
    });

    const clearBtn = $('speechRecClearBtn');
    if (clearBtn) clearBtn.hidden = !hasBank;
    const start = $('speechRecStartBtn');
    if (start && !encoding) {
        start.textContent = hasBank ? 'Record again' : '● Start recording';
    }
}

function stopTracks() {
    if (recordingTimer) {
        clearTimeout(recordingTimer);
        recordingTimer = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch (_) { /* ignore */ }
    }
    mediaRecorder = null;
    if (mediaStream) {
        mediaStream.getTracks().forEach((t) => {
            try { t.stop(); } catch (_) { /* ignore */ }
        });
        mediaStream = null;
    }
}

function setRecordingUi(isRecording) {
    const start = $('speechRecStartBtn');
    const stop = $('speechRecStopBtn');
    if (start) {
        start.hidden = !!isRecording;
        start.disabled = !!encoding;
    }
    if (stop) {
        stop.hidden = !isRecording;
        stop.disabled = !isRecording;
    }
    syncSpeechRecUi();
}

function stopPreview() {
    if (previewNode) {
        try { previewNode.stop(); } catch (_) { /* ignore */ }
        try { previewNode.disconnect(); } catch (_) { /* ignore */ }
        previewNode = null;
    }
    previewMode = null;
    document.querySelectorAll('.speech-rec-preview__btn').forEach((btn) => {
        btn.classList.remove('is-on');
    });
}

let previewCtx = null;

function getPreviewCtx() {
    if (state.audioContext) return state.audioContext;
    if (!previewCtx) {
        try { previewCtx = new AudioContext(); } catch (_) { return null; }
    }
    return previewCtx;
}

function playFloat32(samples, sampleRate, mode) {
    const ctx = getPreviewCtx();
    if (!ctx || !samples || !samples.length) {
        setStatus('Audio is not available for preview yet.');
        return;
    }
    stopPreview();
    if (ctx.state === 'suspended') {
        try { ctx.resume(); } catch (_) { /* ignore */ }
    }
    const rate = ctx.sampleRate || sampleRate;
    let playback = samples;
    if (Math.abs(rate - sampleRate) > 1) {
        const outLen = Math.max(1, Math.floor(samples.length * rate / sampleRate));
        const out = new Float32Array(outLen);
        const srcStep = samples.length / outLen;
        for (let i = 0; i < outLen; i++) {
            const src = i * srcStep;
            const i0 = Math.floor(src);
            const i1 = Math.min(samples.length - 1, i0 + 1);
            const t = src - i0;
            out[i] = samples[i0] * (1 - t) + samples[i1] * t;
        }
        playback = out;
    }
    const buf = ctx.createBuffer(1, playback.length, rate);
    buf.getChannelData(0).set(playback);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => {
        if (previewNode === src) stopPreview();
    };
    previewNode = src;
    previewMode = mode;
    document.querySelectorAll('.speech-rec-preview__btn').forEach((btn) => {
        btn.classList.toggle('is-on', btn.dataset.preview === mode);
    });
    src.start();
}

function playPreview(mode) {
    if (previewMode === mode) {
        stopPreview();
        return;
    }
    const bytes = getSpeechUserBankBytes();
    if (mode === 'source') {
        if (!lastSource8k || !lastSource8k.length) return;
        playFloat32(lastSource8k, SPEECH_LPC_SR, 'source');
        return;
    }
    if (!bytes || !bytes.length) return;
    if (mode === 'natural') {
        if (!previewCache.natural) previewCache.natural = renderLpcPreview(bytes, { flat: false });
        playFloat32(previewCache.natural, SPEECH_LPC_SR, 'natural');
        return;
    }
    if (mode === 'flat') {
        if (!previewCache.flat) previewCache.flat = renderLpcPreview(bytes, { flat: true });
        playFloat32(previewCache.flat, SPEECH_LPC_SR, 'flat');
    }
}

function resetPreviewCache() {
    stopPreview();
    previewCache.natural = null;
    previewCache.flat = null;
}

export function openSpeechRecModal() {
    const modal = $('speechRecModal');
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    setProgress(0, false);
    setRecordingUi(false);
    if (encoding) {
        setStatus('Encoding…');
        setProgress(0.5, true);
        hideReady();
    } else if (state.osc4SpeechUserBank && hasSpeechUserBank()) {
        lastMeta = lastMeta || loadMeta();
        refreshReadyFromBank();
        setStatus('USER bank loaded. Preview, record again to replace, or Clear to restore factory Voice.');
    } else {
        hideReady();
        setStatus('Ready to record.');
    }
    syncSpeechRecUi();
}

export function closeSpeechRecModal() {
    if (encoding) return;
    stopTracks();
    stopPreview();
    setRecordingUi(false);
    setProgress(0, false);
    const modal = $('speechRecModal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
}

async function finishRecording(blob) {
    encoding = true;
    setRecordingUi(false);
    hideReady();
    resetPreviewCache();
    lastSource8k = null;
    setProgress(0.05, true);
    setStatus('Encoding to LPC…');
    try {
        const audio = await decodeBlobToMono(blob, state.audioContext);
        const result = encodeRecordingToUserBank(audio, {
            onProgress: (p, msg) => {
                setProgress(p, true);
                setStatus(msg);
            },
        });
        applySpeechUserBankToLive({
            bytes: result.bytes,
            active: true,
            persist: true,
        });
        lastSource8k = result.source8k || null;
        const meta = {
            wordCount: result.wordCount,
            frameCount: result.frameCount,
            durationSec: result.durationSec,
            gainDb: result.gainDb,
            byteLength: result.bytes.length,
        };
        saveMeta(meta);
        resetPreviewCache();
        showReady(meta);
        setProgress(0, false);
        setStatus(`USER bank ready — ${result.wordCount} word${result.wordCount === 1 ? '' : 's'}.`);
        encoding = false;
        setRecordingUi(false);
        syncSpeechRecUi();
        notifyUserBankUiChange();
    } catch (err) {
        encoding = false;
        setProgress(0, false);
        setStatus(err?.message || String(err));
        if (hasSpeechUserBank()) refreshReadyFromBank();
        else hideReady();
        setRecordingUi(false);
        syncSpeechRecUi();
    }
}

async function startRecording() {
    if (encoding) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setStatus('This browser cannot record from the microphone.');
        return;
    }
    stopPreview();
    recordedChunks = [];
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                channelCount: 1,
            },
        });
    } catch (_) {
        setStatus('Microphone permission denied.');
        return;
    }

    let mime = '';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
    else if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
    else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';

    try {
        mediaRecorder = mime
            ? new MediaRecorder(mediaStream, { mimeType: mime })
            : new MediaRecorder(mediaStream);
    } catch (_) {
        stopTracks();
        setStatus('Could not start MediaRecorder.');
        return;
    }

    mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recordedChunks.push(ev.data);
    };
    mediaRecorder.onstop = () => {
        const tracks = mediaStream;
        mediaStream = null;
        if (tracks) tracks.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* ignore */ } });
        const type = mediaRecorder?.mimeType || mime || 'audio/webm';
        mediaRecorder = null;
        const blob = new Blob(recordedChunks, { type });
        recordedChunks = [];
        if (!blob.size) {
            setStatus('Recording was empty. Try again.');
            setRecordingUi(false);
            if (hasSpeechUserBank()) refreshReadyFromBank();
            return;
        }
        finishRecording(blob);
    };

    hideReady();
    mediaRecorder.start(100);
    setRecordingUi(true);
    setProgress(0, false);
    setStatus(`Recording… (max ${SPEECH_LPC_MAX_SEC}s). Leave ≥0.5s silence between words.`);
    recordingTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            try { mediaRecorder.stop(); } catch (_) { /* ignore */ }
        }
    }, SPEECH_LPC_MAX_SEC * 1000);
}

function stopRecording() {
    if (recordingTimer) {
        clearTimeout(recordingTimer);
        recordingTimer = null;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        setStatus('Finishing recording…');
        try { mediaRecorder.stop(); } catch (_) { /* ignore */ }
    }
}

function clearUserBank() {
    if (encoding) return;
    stopTracks();
    resetPreviewCache();
    lastSource8k = null;
    saveMeta(null);
    clearSpeechUserBank();
    hideReady();
    syncSpeechRecUi();
    notifyUserBankUiChange();
    setProgress(0, false);
    setStatus('USER bank cleared. Factory Voice MODEL is back.');
}

function toggleUserBank() {
    if (encoding) return;
    if (!hasSpeechUserBank()) {
        openSpeechRecModal();
        setStatus('No USER bank yet. Record one first.');
        return;
    }
    const next = !state.osc4SpeechUserBank;
    setSpeechUserBankActive(next);
    syncSpeechRecUi();
    notifyUserBankUiChange();
}

export function initSpeechRecUi() {
    lastMeta = loadMeta();
    syncSpeechRecUi();
    document.querySelectorAll('.osc4-speech-rec-btn').forEach((btn) => {
        btn.addEventListener('click', () => openSpeechRecModal());
    });
    document.querySelectorAll('.osc4-speech-user-btn').forEach((btn) => {
        btn.addEventListener('click', () => toggleUserBank());
    });
    $('speechRecStartBtn')?.addEventListener('click', () => startRecording());
    $('speechRecStopBtn')?.addEventListener('click', () => stopRecording());
    $('speechRecClearBtn')?.addEventListener('click', () => clearUserBank());
    const src = $('speechRecPreviewSource');
    const nat = $('speechRecPreviewNatural');
    const flat = $('speechRecPreviewFlat');
    if (src) {
        src.dataset.preview = 'source';
        src.addEventListener('click', () => playPreview('source'));
    }
    if (nat) {
        nat.dataset.preview = 'natural';
        nat.addEventListener('click', () => playPreview('natural'));
    }
    if (flat) {
        flat.dataset.preview = 'flat';
        flat.addEventListener('click', () => playPreview('flat'));
    }
    document.querySelectorAll('[data-speech-rec-dismiss]').forEach((el) => {
        el.addEventListener('click', () => closeSpeechRecModal());
    });
    document.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        const modal = $('speechRecModal');
        if (modal && !modal.hidden) closeSpeechRecModal();
    });
}
