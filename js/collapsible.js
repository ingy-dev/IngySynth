// Reusable collapsible fieldset: legend text matches other field labels,
// with a ▶/▼ arrow toggle. Use on any fieldset with:
//   class="collapsible-fieldset"  (+ optional "collapsed")
//   <legend class="collapsible-legend">
//     <button type="button" class="collapsible-toggle" aria-expanded="..." aria-controls="panelId">
//       <span class="collapsible-label">Title</span>
//       <span class="collapsible-arrow" aria-hidden="true"></span>
//     </button>
//   </legend>
//   <div id="panelId" class="collapsible-panel">...</div>
// Add collapsible-mobile-only to collapse only at max-width 768px;
// desktop stays expanded with no toggle.

const MOBILE_COLLAPSE_MQ = '(max-width: 768px)';

function isMobileCollapseViewport() {
    return window.matchMedia(MOBILE_COLLAPSE_MQ).matches;
}

function applyMobileOnlyCollapsible(fieldset) {
    if (!fieldset.classList.contains('collapsible-mobile-only')) return;
    const toggle = fieldset.querySelector('.collapsible-toggle');
    if (isMobileCollapseViewport()) {
        if (toggle) toggle.tabIndex = 0;
        if (fieldset.dataset.mobileExpanded === 'false') {
            setCollapsibleExpanded(fieldset, false);
        }
        return;
    }
    fieldset.dataset.mobileExpanded = fieldset.classList.contains('collapsed') ? 'false' : 'true';
    setCollapsibleExpanded(fieldset, true);
    if (toggle) toggle.tabIndex = -1;
}

let mobileOnlyMqBound = false;

function ensureMobileOnlyMediaListener() {
    if (mobileOnlyMqBound || typeof window === 'undefined' || !window.matchMedia) return;
    mobileOnlyMqBound = true;
    const mq = window.matchMedia(MOBILE_COLLAPSE_MQ);
    const syncAll = () => {
        document.querySelectorAll('.collapsible-fieldset.collapsible-mobile-only').forEach(
            applyMobileOnlyCollapsible
        );
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', syncAll);
    else mq.addListener(syncAll);
}

/**
 * Sync a single collapsible fieldset's expanded/collapsed UI.
 * @param {HTMLElement} fieldset
 * @param {boolean} expanded
 */
export function setCollapsibleExpanded(fieldset, expanded) {
    if (!fieldset) return;
    // Locked open (e.g. automation record) — ignore collapse requests
    if (fieldset.classList.contains('collapse-locked') && !expanded) return;
    const toggle = fieldset.querySelector('.collapsible-toggle');
    const panel = fieldset.querySelector('.collapsible-panel');
    fieldset.classList.toggle('collapsed', !expanded);
    if (panel) {
        panel.classList.toggle('hidden', !expanded);
        panel.hidden = !expanded;
    }
    if (toggle) {
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
}

/**
 * Lock a fieldset open (non-collapsible) or restore normal toggle behavior.
 * @param {HTMLElement|null} fieldset
 * @param {boolean} locked
 */
export function setCollapsibleLocked(fieldset, locked) {
    if (!fieldset) return;
    const on = !!locked;
    fieldset.classList.toggle('collapse-locked', on);
    const toggle = fieldset.querySelector('.collapsible-toggle');
    if (toggle) {
        toggle.disabled = on;
        toggle.setAttribute('aria-disabled', on ? 'true' : 'false');
    }
    if (on) setCollapsibleExpanded(fieldset, true);
}

function collectCollapsibleFieldsets(root) {
    const fieldsets = [];
    if (root instanceof Element && root.matches('.collapsible-fieldset')) {
        fieldsets.push(root);
    }
    root.querySelectorAll('.collapsible-fieldset').forEach((fieldset) => {
        if (!fieldsets.includes(fieldset)) fieldsets.push(fieldset);
    });
    return fieldsets;
}

/**
 * Wire click handlers for all .collapsible-fieldset elements (or a root).
 * Returns a Map of fieldset → { getExpanded, setExpanded }.
 * @param {ParentNode} [root=document]
 * @param {{ onToggle?: (fieldset: HTMLElement, expanded: boolean) => void }} [options]
 */
export function initCollapsibles(root = document, options = {}) {
    const controllers = new Map();
    const { onToggle } = options;

    collectCollapsibleFieldsets(root).forEach((fieldset) => {
        const toggle = fieldset.querySelector('.collapsible-toggle');
        if (!toggle) return;

        const getExpanded = () => !fieldset.classList.contains('collapsed');
        const setExpanded = (expanded) => {
            setCollapsibleExpanded(fieldset, expanded);
            if (fieldset.classList.contains('collapsible-mobile-only') && isMobileCollapseViewport()) {
                fieldset.dataset.mobileExpanded = expanded ? 'true' : 'false';
            }
            if (typeof onToggle === 'function') onToggle(fieldset, expanded);
        };

        // Honor initial .collapsed class from markup
        setCollapsibleExpanded(fieldset, getExpanded());
        applyMobileOnlyCollapsible(fieldset);
        ensureMobileOnlyMediaListener();

        toggle.addEventListener('click', () => {
            if (fieldset.classList.contains('collapse-locked') || toggle.disabled) return;
            if (fieldset.classList.contains('collapsible-mobile-only') && !isMobileCollapseViewport()) return;
            setExpanded(!getExpanded());
        });

        controllers.set(fieldset, { getExpanded, setExpanded });
    });

    return controllers;
}
