// Floating phosphor window shared by every mode that needs a popover editor.
// Desktop: non-modal, dragged by its title bar, resized from the grow box, geometry kept per id.
// Phones (narrow or coarse-pointer short screens): a bottom sheet pinned to the safe area.
//
// Look and behaviour (Design Lab "window 4c", 2026-11): a 2px line frame with a solid lit slab offset
// behind it and a lit title band; the page under an open window dims (not the menu bar); windows open
// codec-style (a lit line snaps out across the middle, then opens up and down with a brief flicker) and
// close the same way backwards; minimize drops a window to a black tab on the bottom edge (zoom rects
// carry it down), and the tab brings it back to the same place and size.

const STORE_PREFIX = 'ingysynth:window:';
const MIN_W = 320;
const MIN_H = 220;
const EDGE = 8;
const SHEET_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 520px)';
const TAB_H = 24;
const TAB_MAX = 300;

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

function reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function topmostOpen() {
    let best = null;
    windows.forEach((w) => {
        if (!w.isOpen() || w.isMinimized()) return;
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

// ---- The dim under open windows: covers the page below the menu bar (header.site-bar), never takes
// clicks (windows are non-modal). On while any window is open and not minimized.
let dimEl = null;
function syncDim() {
    if (!dimEl) {
        dimEl = document.createElement('div');
        dimEl.className = 'ingy-window-dim';
        dimEl.setAttribute('aria-hidden', 'true');
        document.body.appendChild(dimEl);
    }
    const bar = document.querySelector('header.site-bar');
    const top = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
    dimEl.style.top = `${top}px`;
    let on = false;
    windows.forEach((w) => { if (w.isOpen() && !w.isMinimized() && !w.el.classList.contains('is-sheet')) on = true; });
    dimEl.classList.toggle('is-on', on);
}
window.addEventListener('resize', () => { if (dimEl) syncDim(); });

// ---- Effects drawn over the page while a window opens, closes or minimizes.
function fxLayer() {
    const l = document.createElement('div');
    l.className = 'ingy-window-fx';
    document.body.appendChild(l);
    return l;
}
function placeBox(n, r) {
    n.style.left = `${r.left}px`;
    n.style.top = `${r.top}px`;
    n.style.width = `${r.width}px`;
    n.style.height = `${r.height}px`;
}
const rectOf = (node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
};

// Zoom rects (classic Mac): outlines step from rect a to rect b, each fading as the next lands.
function zoomRects(a, b, ms, steps = 6) {
    const l = fxLayer();
    const step = ms / steps;
    return new Promise((resolve) => {
        let i = 0;
        const tick = () => {
            i += 1;
            const k = i / steps;
            const n = document.createElement('div');
            n.className = 'ingy-window-fx__rect';
            placeBox(n, {
                left: a.left + (b.left - a.left) * k,
                top: a.top + (b.top - a.top) * k,
                width: a.width + (b.width - a.width) * k,
                height: a.height + (b.height - a.height) * k,
            });
            l.appendChild(n);
            n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: step * 3, fill: 'forwards' });
            if (i < steps) setTimeout(tick, step);
            else {
                setTimeout(() => l.remove(), step * 3);
                setTimeout(resolve, step);
            }
        };
        tick();
    });
}

// Codec open / close. dir 1 = open: a lit line draws out across the window's middle (130ms), the window
// opens up and down from it (160ms) and flickers bright as it settles. dir -1 = close: the window folds to
// the middle line (85ms) and the line shrinks to a dot and goes out.
async function codec(el, dir) {
    const w = rectOf(el);
    if (!w.width || !w.height) return;
    const l = fxLayer();
    const line = document.createElement('div');
    line.className = 'ingy-window-fx__line';
    l.appendChild(line);
    placeBox(line, { left: w.left, top: w.top + w.height / 2 - 1, width: w.width, height: 2 });
    const shut = 'inset(calc(50% - 1px) 0 calc(50% - 1px) 0)';
    const full = 'inset(0 -12px -12px 0)';   // room for the offset slab
    const dot = `scaleX(${4 / w.width})`;
    try {
        if (dir > 0) {
            el.style.visibility = 'hidden';
            await line.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 130, easing: 'ease-out', fill: 'both' }).finished;
            el.style.visibility = '';
            line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'both' });
            await el.animate([{ clipPath: shut }, { clipPath: full }], { duration: 160, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'both' }).finished;
            await el.animate([{ filter: 'brightness(1.8)' }, { filter: 'brightness(.8)' }, { filter: 'brightness(1.3)' }, { filter: 'none' }], { duration: 130 }).finished;
        } else {
            line.style.opacity = '0';
            await el.animate([{ clipPath: full }, { clipPath: shut }], { duration: 85, easing: 'ease-in', fill: 'both' }).finished;
            el.style.visibility = 'hidden';
            line.style.opacity = '';
            await line.animate([{ transform: 'scaleX(1)', opacity: 1 }, { transform: dot, opacity: 1, offset: 0.75 }, { transform: dot, opacity: 0 }],
                { duration: 160, easing: 'ease-in', fill: 'both' }).finished;
        }
    } catch {
        // An animation can be cancelled (window reopened mid-close); the cleanup below still runs.
    }
    el.getAnimations().forEach((a) => a.cancel());
    el.style.visibility = '';
    l.remove();
}

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
            <button type="button" class="ingy-window__min" aria-label="Minimize" title="Minimize"></button>
            <button type="button" class="ingy-window__close" aria-label="Close" title="Close (Esc)"></button>
            <span class="ingy-window__grip" aria-hidden="true"></span>
        </header>
        <div class="ingy-window__body"></div>
        <span class="ingy-window__grow" aria-hidden="true"></span>
    `;
    document.body.appendChild(el);

    // Minimized, the window is this tab on the bottom edge: its title and a restore square.
    const tab = document.createElement('div');
    tab.className = 'ingy-window-tab';
    tab.hidden = true;
    tab.setAttribute('role', 'button');
    tab.tabIndex = 0;
    tab.title = 'Restore';
    tab.innerHTML = '<span class="ingy-window-tab__title"></span><span class="ingy-window-tab__icon" aria-hidden="true"></span>';
    document.body.appendChild(tab);

    const bar = el.querySelector('.ingy-window__bar');
    const titleEl = el.querySelector('.ingy-window__title');
    const body = el.querySelector('.ingy-window__body');
    const grow = el.querySelector('.ingy-window__grow');
    titleEl.textContent = opts.title || '';
    if (opts.label) el.setAttribute('aria-label', opts.label);

    let open = false;
    let minimized = false;
    let busy = null;          // the running open / close animation
    let geom = readGeometry(id);
    let fitSaved = null;      // the height to go back to after fitHeight
    let tabX = EDGE;

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

    function placeTab() {
        const w = Math.min(TAB_MAX, geom?.w || TAB_MAX);
        tab.style.width = `${w}px`;
        tab.style.left = `${Math.max(EDGE, Math.min(tabX, window.innerWidth - w - EDGE))}px`;
    }

    function layout() {
        const sheet = isSheet();
        el.classList.toggle('is-sheet', sheet);
        if (sheet) {
            el.style.left = el.style.top = el.style.width = el.style.height = '';
            if (minimized) restoreNow();
            syncDim();
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
        if (minimized) placeTab();
        syncDim();
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

    function saveGeometry() {
        // A height fitted to its content (fold, steps) isn't the window's own size: keep the real one.
        writeGeometry(id, fitSaved != null ? { ...geom, h: fitSaved } : geom);
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
            saveGeometry();
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', end);
        target.addEventListener('pointercancel', end);
    }

    // ---- minimize: down to the tab (zoom rects), and back to the same place and size
    function tabRect() {
        const w = Math.min(TAB_MAX, geom.w);
        const left = Math.max(EDGE, Math.min(tabX, window.innerWidth - w - EDGE));
        return { left, top: window.innerHeight - TAB_H, width: w, height: TAB_H };
    }
    function minimize() {
        if (!open || minimized || el.classList.contains('is-sheet')) return;
        const from = rectOf(el);
        tabX = from.left;
        minimized = true;
        tab.querySelector('.ingy-window-tab__title').textContent = titleEl.textContent;
        el.hidden = true;
        placeTab();
        syncDim();
        const done = () => { if (minimized && open) tab.hidden = false; };
        if (reducedMotion()) done();
        else zoomRects(from, tabRect(), 240).then(done);
    }
    function restoreNow() {
        minimized = false;
        tab.hidden = true;
        el.hidden = !open;
    }
    function restore() {
        if (!minimized) return;
        const from = rectOf(tab);
        restoreNow();
        layout();
        raise();
        if (reducedMotion() || !from.width) return;
        const to = rectOf(el);
        el.style.visibility = 'hidden';
        zoomRects(from, to, 240).then(() => {
            el.style.visibility = '';
            el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90 });
        });
    }
    // The tab: a click restores; dragged sideways it moves along the edge; dragged up it becomes the
    // window again where it's dropped.
    tab.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        tab.setPointerCapture?.(event.pointerId);
        const sx = event.clientX;
        const sy = event.clientY;
        const x0 = tabX;
        let moved = false;
        const move = (e) => {
            const dx = e.clientX - sx;
            const dy = e.clientY - sy;
            if (!moved && Math.hypot(dx, dy) > 4) moved = true;
            if (!moved) return;
            if (dy < -40) {
                end();
                geom = clamp({ ...geom, x: e.clientX - 40, y: e.clientY - 12 });
                restoreNow();
                layout();
                raise();
                saveGeometry();
                return;
            }
            tabX = x0 + dx;
            placeTab();
        };
        const end = () => {
            tab.removeEventListener('pointermove', move);
            tab.removeEventListener('pointerup', up);
            tab.removeEventListener('pointercancel', end);
        };
        const up = () => {
            end();
            if (!moved) restore();
        };
        tab.addEventListener('pointermove', move);
        tab.addEventListener('pointerup', up);
        tab.addEventListener('pointercancel', end);
    });
    tab.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        restore();
    });

    bar.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        track(event, (s, dx, dy) => ({ x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }));
    });
    bar.addEventListener('dblclick', (event) => {
        if (event.target.closest('button') || el.classList.contains('is-sheet')) return;
        fitSaved = null;
        geom = defaultGeometry();
        layout();
        writeGeometry(id, geom);
    });
    grow.addEventListener('pointerdown', (event) => {
        fitSaved = null;   // resized by hand: that's the window's size now
        track(event, (s, dx, dy) => ({ x: s.x, y: s.y, w: s.w + dx, h: s.h + dy }));
    });
    el.addEventListener('pointerdown', raise, true);
    el.querySelector('.ingy-window__close').addEventListener('click', () => api.close());
    el.querySelector('.ingy-window__min').addEventListener('click', () => minimize());
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
        isMinimized: () => minimized,
        setTitle(text) {
            titleEl.textContent = text;
            if (minimized) tab.querySelector('.ingy-window-tab__title').textContent = text;
        },
        open() {
            if (minimized) {
                restore();
                return;
            }
            if (!open) {
                open = true;
                el.hidden = false;
                layout();
                raise();
                if (!reducedMotion()) busy = codec(el, 1).finally(() => { busy = null; });
            }
            raise();
        },
        close() {
            if (!open) return;
            open = false;
            const wasMin = minimized;
            minimized = false;
            tab.hidden = true;
            syncDim();
            const finish = () => {
                if (open) return;           // reopened while closing
                el.hidden = true;
                opts.onClose?.();
            };
            if (wasMin || el.hidden || reducedMotion()) finish();
            else codec(el, -1).then(finish);
        },
        minimize,
        restore,
        // Fit the window's height to its content (contentH px under the title band), e.g. a folded roll.
        // shrink: only ever smaller than the window's own height; more rows than that scroll. null puts
        // the window's own height back.
        fitHeight(contentH, { shrink = false } = {}) {
            if (!open || minimized || el.classList.contains('is-sheet') || !geom) return;
            if (contentH == null) {
                if (fitSaved == null) return;
                geom = clamp({ ...geom, h: fitSaved });
                fitSaved = null;
                layout();
                return;
            }
            const chrome = el.offsetHeight - body.clientHeight;
            if (fitSaved == null) fitSaved = geom.h;
            const h = Math.ceil(contentH + chrome);
            geom = clamp({ ...geom, h: shrink ? Math.min(h, fitSaved) : h });
            layout();
        },
    };
    windows.add(api);
    return api;
}
