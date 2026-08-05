// Keep keyboard-panel controls visually matched to main-panel counterparts.
// Click listeners alone are brittle (init order, programmatic updates); observe
// the main control's class/label and push state to the keyboard mirror.

/**
 * @param {Element | null} mainEl
 * @param {() => void} sync
 * @param {{ subtree?: boolean }} [opts]
 * @returns {() => void} disconnect
 */
export function observeMainControl(mainEl, sync, opts = {}) {
    if (!mainEl || typeof sync !== 'function') return () => {};

    const run = () => {
        try {
            sync();
        } catch (_) {
            /* ignore sync errors from detached nodes */
        }
    };

    run();

    const observer = new MutationObserver(run);
    observer.observe(mainEl, {
        attributes: true,
        attributeFilter: ['class', 'aria-pressed', 'data-ratch'],
        childList: true,
        characterData: true,
        subtree: opts.subtree !== false,
    });

    // Also catch the common click path immediately after other handlers run
    const onClick = () => queueMicrotask(run);
    mainEl.addEventListener('click', onClick);

    return () => {
        observer.disconnect();
        mainEl.removeEventListener('click', onClick);
    };
}

/**
 * Sync a keyboard on/off-style button from a main pushable (reads .front / .off).
 * @param {HTMLElement | null} kbBtn
 * @param {HTMLElement | null} mainBtn
 * @param {{ onLabel?: string, offLabel?: string, updateLabel?: boolean }} [opts]
 */
export function syncToggleButtonFromMain(kbBtn, mainBtn, opts = {}) {
    if (!kbBtn || !mainBtn) return;
    const onLabel = opts.onLabel ?? 'On';
    const offLabel = opts.offLabel ?? 'Off';
    const front = mainBtn.querySelector('.front');
    const on = front
        ? front.textContent.trim() === onLabel
        : !mainBtn.classList.contains('off');
    kbBtn.classList.toggle('off', !on);
    if (opts.updateLabel !== false) {
        kbBtn.textContent = on ? onLabel : offLabel;
    }
    kbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/**
 * Sync a keyboard accent/slide-style button from a main pushable (.off class only).
 * @param {HTMLElement | null} kbBtn
 * @param {HTMLElement | null} mainBtn
 */
export function syncClassButtonFromMain(kbBtn, mainBtn) {
    if (!kbBtn || !mainBtn) return;
    const on = !mainBtn.classList.contains('off');
    kbBtn.classList.toggle('off', !on);
    kbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}
