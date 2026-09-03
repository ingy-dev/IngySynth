// Per-step Metropolix-style ratcheting: 1 = off, 2–4 = repeats per clock step.

export const RATCH_MAX = 4;

export function clampRatch(n) {
    const v = Math.round(Number(n) || 1);
    return Math.max(1, Math.min(RATCH_MAX, v));
}

export function formatRatchLabel(n) {
    const r = clampRatch(n);
    return r <= 1 ? 'Ratch' : `R ${r}`;
}

/** Off → 2 → … → 4 → Off */
export function nextRatch(n) {
    const r = clampRatch(n);
    if (r <= 1) return 2;
    if (r >= RATCH_MAX) return 1;
    return r + 1;
}

export function syncRatchButton(btn, n) {
    if (!btn) return;
    const r = clampRatch(n);
    btn.dataset.ratch = String(r);
    const front = btn.querySelector('.front');
    const label = formatRatchLabel(r);
    if (front) front.textContent = label;
    else btn.textContent = label;
    btn.classList.toggle('off', r <= 1);
    btn.setAttribute('aria-pressed', r > 1 ? 'true' : 'false');
}

export function readRatchFromButton(btn) {
    return clampRatch(parseInt(btn?.dataset?.ratch, 10) || 1);
}
