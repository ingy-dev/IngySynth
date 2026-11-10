// Floating phosphor window shared by every mode that needs a popover editor.
// Desktop: non-modal, dragged by its title bar, resized from the grow box, geometry kept per id.
// Phones (narrow or coarse-pointer short screens): a bottom sheet pinned to the safe area.

const STORE_PREFIX = 'ingysynth:window:';
const MIN_W = 320;
const MIN_H = 220;
const EDGE = 8;
const SHEET_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 520px)';

const windows = new Set();
let zTop = 10200;

function readGeometry(id) {
    try {
        const raw = localStorage.getItem(STORE_PREFIX + id);
        if (!raw) return null;
        const g = JSON.parse(raw);
        if (![g.x, g.y, g.w, g.h].every(Number.isFinite)) return null;
        return g;
    } catch {
        return null;
    }
}

function writeGeometry(id, g) {
    try {
        localStorage.setItem(STORE_PREFIX + id, JSON.stringify(g));
    } catch {
        // Storage can be blocked; the window just opens at its default place next time.
    }
}

function isSheet() {
    return window.matchMedia(SHEET_QUERY).matches;
}

function topmostOpen() {
    let best = null;
    windows.forEach((w) => {
        if (!w.isOpen()) return;
        if (!best || (w.el.style.zIndex | 0) > (best.el.style.zIndex | 0)) best = w;
    });
    return best;
}

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const w = topmostOpen();
    if (!w) return;
    event.preventDefault();
    event.stopPropagation();
    w.close();
}, true);

/**
 * @param {{ id: string, title?: string, label?: string, width?: number, height?: number, onClose?: () => void }} opts
 */
export function createIngyWindow(opts) {
    const id = opts.id;
    const el = document.createElement('section');
    el.className = 'ingy-window';
    el.id = `${id}Window`;
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'false');
    el.setAttribute('aria-labelledby', `${id}WindowTitle`);
    el.innerHTML = `
        <header class="ingy-window__bar">
            <span class="ingy-window__stripes" aria-hidden="true"></span>
            <h2 class="ingy-window__title" id="${id}WindowTitle"></h2>
            <span class="ingy-window__stripes" aria-hidden="true"></span>
            <button type="button" class="ingy-window__close" aria-label="Close" title="Close (Esc)"></button>
            <span class="ingy-window__grip" aria-hidden="true"></span>
        </header>
        <div class="ingy-window__body"></div>
        <span class="ingy-window__grow" aria-hidden="true"></span>
    `;
    document.body.appendChild(el);

    const bar = el.querySelector('.ingy-window__bar');
    const titleEl = el.querySelector('.ingy-window__title');
    const body = el.querySelector('.ingy-window__body');
    const grow = el.querySelector('.ingy-window__grow');
    titleEl.textContent = opts.title || '';
    if (opts.label) el.setAttribute('aria-label', opts.label);

    let open = false;
    let geom = readGeometry(id);

    function defaultGeometry() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.min(opts.width || 760, vw - EDGE * 2);
        const h = Math.min(opts.height || 460, vh - EDGE * 2);
        return { x: Math.round((vw - w) / 2), y: Math.round(Math.max(EDGE, (vh - h) * 0.35)), w, h };
    }

    function clamp(g) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.max(Math.min(MIN_W, vw - EDGE * 2), Math.min(g.w, vw - EDGE * 2));
        const h = Math.max(Math.min(MIN_H, vh - EDGE * 2), Math.min(g.h, vh - EDGE * 2));
        const x = Math.max(EDGE, Math.min(g.x, vw - w - EDGE));
        const y = Math.max(EDGE, Math.min(g.y, vh - h - EDGE));
        return { x, y, w, h };
    }

    function layout() {
        const sheet = isSheet();
        el.classList.toggle('is-sheet', sheet);
        if (sheet) {
            el.style.left = el.style.top = el.style.width = el.style.height = '';
            return;
        }
        geom = clamp(geom || defaultGeometry());
        // The CSS caps keep the window on screen even when this runs with stale numbers
        // (a phone turned sideways can report its old size for a frame).
        const w = `min(${geom.w}px, 100% - ${EDGE * 2}px)`;
        const h = `min(${geom.h}px, 100% - ${EDGE * 2}px)`;
        el.style.width = w;
        el.style.height = h;
        el.style.left = `max(${EDGE}px, min(${geom.x}px, 100% - ${w} - ${EDGE}px))`;
        el.style.top = `max(${EDGE}px, min(${geom.y}px, 100% - ${h} - ${EDGE}px))`;
    }
    function relayout() {
        if (!open) return;
        layout();
        // Lay out again once the rotation or resize has settled.
        requestAnimationFrame(() => {
            if (open) layout();
        });
    }

    function raise() {
        zTop += 1;
        el.style.zIndex = String(zTop);
        windows.forEach((w) => w.el.classList.toggle('is-front', w.el === el));
    }

    function track(event, onMove) {
        if (event.button !== 0 || el.classList.contains('is-sheet')) return;
        event.preventDefault();
        const start = { px: event.clientX, py: event.clientY, ...geom };
        const pointer = event.pointerId;
        const target = event.currentTarget;
        target.setPointerCapture?.(pointer);
        el.classList.add('is-moving');
        const move = (e) => {
            if (e.pointerId !== pointer) return;
            geom = clamp(onMove(start, e.clientX - start.px, e.clientY - start.py));
            layout();
        };
        const end = (e) => {
            if (e.pointerId !== pointer) return;
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', end);
            target.removeEventListener('pointercancel', end);
            el.classList.remove('is-moving');
            writeGeometry(id, geom);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', end);
        target.addEventListener('pointercancel', end);
    }

    bar.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        track(event, (s, dx, dy) => ({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }));
    });
    bar.addEventListener('dblclick', (event) => {
        if (event.target.closest('button') || el.classList.contains('is-sheet')) return;
        geom = defaultGeometry();
        layout();
        writeGeometry(id, geom);
    });
    grow.addEventListener('pointerdown', (event) => {
        track(event, (s, dx, dy) => ({ x: s.x, y: s.y, w: s.w + dx, h: s.h + dy }));
    });
    el.addEventListener('pointerdown', raise, true);
    el.querySelector('.ingy-window__close').addEventListener('click', () => api.close());
    // Sheet or floating can change without a resize event (pointer type, rotation), so watch the query too.
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayout);
    window.visualViewport?.addEventListener('resize', relayout);
    window.matchMedia(SHEET_QUERY).addEventListener?.('change', relayout);

    const api = {
        el,
        body,
        titleEl,
        isOpen: () => open,
        setTitle(text) {
            titleEl.textContent = text;
        },
        open() {
            if (!open) {
                open = true;
                el.hidden = false;
                layout();
            }
            raise();
        },
        close() {
            if (!open) return;
            open = false;
            el.hidden = true;
            opts.onClose?.();
        },
    };
    windows.add(api);
    return api;
}
