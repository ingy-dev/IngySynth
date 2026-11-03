// Full Screen vs Tabbed layout: Steps / Synthesizer / Effects / Mixer as folder tabs.
// At max-width 768px a second folder (Step Input / Scale/Tuning / Automation)
// sits above it, with its own active tab.

import { setCollapsibleExpanded } from './collapsible.js?v=75';
import { state } from './state.js?v=120';

export const TAB_FIELDSET_IDS = [
    'keyboardStepsFieldset',
    'keyboardSynthFieldset',
    'keyboardEffectsFieldset',
    'keyboardMixerFieldset',
];

const MOBILE_TAB_FIELDSET_IDS = [
    'keyboardWriteFieldset',
    'keyboardTuningFieldset',
    'keyboardAutomationFieldset',
];

const MOBILE_MQ = '(max-width: 768px)';
const VIEW_MODE_KEY = 'ingysynth.viewMode';

const GROUPS = [
    {
        stripId: 'keyboardTabStrip',
        ids: TAB_FIELDSET_IDS,
        storageKey: 'ingysynth.activeTab',
        defaultId: 'keyboardStepsFieldset',
        mobileOnly: false,
        activeId: 'keyboardStepsFieldset',
    },
    {
        stripId: 'keyboardMobileTabStrip',
        ids: MOBILE_TAB_FIELDSET_IDS,
        storageKey: 'ingysynth.activeMobileTab',
        defaultId: 'keyboardWriteFieldset',
        mobileOnly: true,
        activeId: 'keyboardWriteFieldset',
    },
];

let currentMode = 'full';
let collapseSnapshot = null;
let onTabShow = {};
let wasMobile = false;

function isMobileViewport() {
    return window.matchMedia(MOBILE_MQ).matches;
}

function isGroupEnabled(group) {
    return !group.mobileOnly || isMobileViewport();
}

function groupForId(id) {
    return GROUPS.find((group) => group.ids.includes(id)) || null;
}

function isCollapsibleFieldset(fieldset) {
    return !!(fieldset && fieldset.classList.contains('collapsible-fieldset'));
}

function readStored(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value == null || value === '' ? fallback : value;
    } catch (_) {
        return fallback;
    }
}

function writeStored(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (_) { /* private mode / quota */ }
}

function tabButtons(group) {
    return Array.from(document.querySelectorAll(`#${group.stripId} [role="tab"]`));
}

function syncSwitchButtons() {
    const full = document.getElementById('viewModeFull');
    const tabbed = document.getElementById('viewModeTabbed');
    if (full) {
        full.classList.toggle('off', currentMode !== 'full');
        full.setAttribute('aria-pressed', currentMode === 'full' ? 'true' : 'false');
    }
    if (tabbed) {
        tabbed.classList.toggle('off', currentMode !== 'tabbed');
        tabbed.setAttribute('aria-pressed', currentMode === 'tabbed' ? 'true' : 'false');
    }
}

/** Remember collapse state of a group's panels before tabbed mode forces them open. */
function snapshotGroup(group) {
    if (!collapseSnapshot) collapseSnapshot = {};
    for (const id of group.ids) {
        const fieldset = document.getElementById(id);
        if (!isCollapsibleFieldset(fieldset)) continue;
        collapseSnapshot[id] = !fieldset.classList.contains('collapsed');
    }
}

function restoreGroup(group) {
    if (!collapseSnapshot) return;
    for (const id of group.ids) {
        if (!(id in collapseSnapshot)) continue;
        const expanded = !!collapseSnapshot[id];
        setCollapsibleExpanded(document.getElementById(id), expanded);
        if (id === 'keyboardStepsFieldset') {
            state.keyboardStepsExpanded = expanded;
        }
        delete collapseSnapshot[id];
    }
}

function expandGroup(group) {
    for (const id of group.ids) {
        const fieldset = document.getElementById(id);
        if (isCollapsibleFieldset(fieldset)) setCollapsibleExpanded(fieldset, true);
    }
}

function clearGroupHidden(group) {
    for (const id of group.ids) {
        document.getElementById(id)?.classList.remove('kb-tab-hidden');
    }
}

function scrollActiveTabIntoView(group) {
    const strip = document.getElementById(group.stripId);
    if (!strip) return;
    const tab = strip.querySelector(`[role="tab"][data-tab="${group.activeId}"]`);
    if (!tab) return;
    const stripRect = strip.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    if (tabRect.left < stripRect.left) {
        strip.scrollLeft -= stripRect.left - tabRect.left;
    } else if (tabRect.right > stripRect.right) {
        strip.scrollLeft += tabRect.right - stripRect.right;
    }
}

function syncTabButtons(group) {
    tabButtons(group).forEach((tab) => {
        const on = tab.dataset.tab === group.activeId;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
    });
}

export function isTabbedView() {
    return currentMode === 'tabbed';
}

export function selectKeyboardTab(id) {
    const group = groupForId(id) || GROUPS[0];
    if (!group.ids.includes(id)) id = group.defaultId;
    group.activeId = id;
    const hidePanels = currentMode === 'tabbed' && isGroupEnabled(group);
    for (const fid of group.ids) {
        const fieldset = document.getElementById(fid);
        if (!fieldset) continue;
        fieldset.classList.toggle('kb-tab-hidden', hidePanels && fid !== id);
        if (fid === id && hidePanels && isCollapsibleFieldset(fieldset)) {
            setCollapsibleExpanded(fieldset, true);
        }
    }
    if (id === 'keyboardStepsFieldset') {
        state.keyboardStepsExpanded = true;
    }
    syncTabButtons(group);
    writeStored(group.storageKey, id);
    scrollActiveTabIntoView(group);
    const hook = onTabShow[id];
    if (typeof hook === 'function') hook();
}

function enterGroup(group) {
    snapshotGroup(group);
    expandGroup(group);
    selectKeyboardTab(group.activeId);
}

function leaveGroup(group) {
    clearGroupHidden(group);
    restoreGroup(group);
}

function hasStoredViewMode() {
    const value = readStored(VIEW_MODE_KEY, '');
    return value === 'tabbed' || value === 'full';
}

/** Saved choice wins. Otherwise phones open tabbed and desktop opens full. */
function preferredMode() {
    const stored = readStored(VIEW_MODE_KEY, '');
    if (stored === 'tabbed' || stored === 'full') return stored;
    return isMobileViewport() ? 'tabbed' : 'full';
}

export function setViewMode(mode, options = {}) {
    const persist = options.persist !== false;
    const next = mode === 'tabbed' ? 'tabbed' : 'full';
    if (next === currentMode) {
        syncSwitchButtons();
        return;
    }
    currentMode = next;
    document.body.classList.toggle('view-tabbed', next === 'tabbed');
    for (const group of GROUPS) {
        if (next === 'tabbed') {
            if (isGroupEnabled(group)) enterGroup(group);
        } else {
            leaveGroup(group);
        }
    }
    if (next === 'full') collapseSnapshot = null;
    if (persist) writeStored(VIEW_MODE_KEY, currentMode);
    syncSwitchButtons();
}

function onViewportChange() {
    const mobile = isMobileViewport();
    if (mobile === wasMobile) return;
    wasMobile = mobile;
    // Don't persist the automatic choice: opening the phone must not lock desktop into tabbed.
    if (!hasStoredViewMode()) {
        setViewMode(mobile ? 'tabbed' : 'full', { persist: false });
        return;
    }
    if (currentMode !== 'tabbed') return;
    for (const group of GROUPS) {
        if (!group.mobileOnly) continue;
        if (mobile) enterGroup(group);
        else leaveGroup(group);
    }
}

function onTabKeydown(event) {
    const group = groupForId(event.currentTarget.dataset.tab);
    if (!group) return;
    const tabs = tabButtons(group);
    const index = tabs.indexOf(event.currentTarget);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next].focus();
    selectKeyboardTab(tabs[next].dataset.tab);
}

export function initViewMode(options = {}) {
    onTabShow = options.onTabShow || {};
    wasMobile = isMobileViewport();

    for (const group of GROUPS) {
        const stored = readStored(group.storageKey, group.defaultId);
        group.activeId = group.ids.includes(stored) ? stored : group.defaultId;
        tabButtons(group).forEach((tab) => {
            tab.addEventListener('click', () => selectKeyboardTab(tab.dataset.tab));
            tab.addEventListener('keydown', onTabKeydown);
        });
    }

    document.getElementById('viewModeFull')?.addEventListener('click', () => setViewMode('full'));
    document.getElementById('viewModeTabbed')?.addEventListener('click', () => setViewMode('tabbed'));

    const mq = window.matchMedia(MOBILE_MQ);
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onViewportChange);
    else mq.addListener(onViewportChange);

    const initial = preferredMode();
    if (initial === 'tabbed') setViewMode('tabbed', { persist: hasStoredViewMode() });
    else syncSwitchButtons();
}
