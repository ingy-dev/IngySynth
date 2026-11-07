// Dotted connectors from a trimmer to the knob it modulates, like the printed
// lines on a eurorack panel. A dial with data-mi-link="<target dial id>"
// inside a .mi-link-scope gets a line in the target knob's cap colour.
// Hovering, focusing or dragging the trimmer lights the line and the target.
// Lay trimmers out under their knobs and the line is one straight drop.
// data-mi-link-route="side" climbs to the target's middle and meets its side
// instead (the FM trimmer, centred under TIMBRE / MORPH, to FREQUENCY above).
// Targets can be MI knobs or the mainstage .synth-knob dials.

const SVG_NS = 'http://www.w3.org/2000/svg';
const DOT_GAP_PX = 3;
const DIAL_GAP_PX = 2;
// Held here so the browser never collects an observer whose panel is still on screen.
const observers = [];

function rectIn(el, origin) {
    const r = el.getBoundingClientRect();
    return { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
}

function drawScope(scope, svg, links) {
    const origin = scope.getBoundingClientRect();
    if (origin.width === 0 || origin.height === 0) return;
    svg.setAttribute('width', String(origin.width));
    svg.setAttribute('height', String(origin.height));
    svg.setAttribute('viewBox', `0 0 ${origin.width} ${origin.height}`);

    links.forEach(({ source, target, path }) => {
        const s = rectIn(source, origin);
        const t = rectIn(target, origin);
        const sx = s.left + s.width / 2;
        const sy = s.top - DIAL_GAP_PX;
        if (source.dataset.miLinkRoute === 'side') {
            const ty = t.top + t.height / 2;
            const tx = sx < t.left ? t.left - DIAL_GAP_PX : t.left + t.width + DIAL_GAP_PX;
            path.setAttribute('d', `M ${sx} ${sy} V ${ty} H ${tx}`);
            return;
        }
        const tx = t.left + t.width / 2;
        const ty = t.top + t.height + DIAL_GAP_PX;
        if (Math.abs(sx - tx) < 1) {
            path.setAttribute('d', `M ${tx} ${sy} V ${ty}`);
            return;
        }
        // Offset trimmer: drop, one jog just above the trimmer, then climb.
        const y = sy - DOT_GAP_PX * 2;
        path.setAttribute('d', `M ${sx} ${sy} V ${y} H ${tx} V ${ty}`);
    });
}

function wireHighlight(source, targetKnob, path) {
    let hover = false;
    let focus = false;
    const sync = () => {
        const on = hover || focus || source.classList.contains('active');
        path.classList.toggle('is-hot', on);
        targetKnob?.classList.toggle('is-link-hot', on);
    };
    source.addEventListener('pointerenter', () => { hover = true; sync(); });
    source.addEventListener('pointerleave', () => { hover = false; sync(); });
    source.addEventListener('focus', () => { focus = true; sync(); });
    source.addEventListener('blur', () => { focus = false; sync(); });
    new MutationObserver(sync).observe(source, { attributes: true, attributeFilter: ['class'] });
}

function initScope(scope) {
    if (scope.dataset.miLinksReady) return;
    const sources = [...scope.querySelectorAll('[data-mi-link]')];
    if (!sources.length) return;
    scope.dataset.miLinksReady = '1';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mi-links');
    svg.setAttribute('aria-hidden', 'true');
    scope.prepend(svg);

    const links = sources.map((source) => {
        const target = document.getElementById(source.dataset.miLink);
        if (!target) return null;
        const targetKnob = target.closest('.mi-knob, .synth-knob');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', 'mi-link');
        if (source.id) path.dataset.source = source.id;
        const cap = targetKnob ? getComputedStyle(targetKnob).getPropertyValue('--mi-cap').trim() : '';
        if (cap) path.style.setProperty('--mi-cap', cap);
        svg.appendChild(path);
        wireHighlight(source, targetKnob, path);
        return { source, target, path };
    }).filter(Boolean);

    // Watch the knobs too: the scope's own box can stay the same size while
    // the panel goes from hidden to shown, and then it never reports.
    const redraw = () => drawScope(scope, svg, links);
    const ro = new ResizeObserver(redraw);
    observers.push(ro);
    ro.observe(scope);
    links.forEach(({ source, target }) => {
        ro.observe(source);
        ro.observe(target);
    });
    redraw();
}

export function initMiKnobLinks(root = document) {
    root.querySelectorAll('.mi-link-scope').forEach(initScope);
}

initMiKnobLinks();
