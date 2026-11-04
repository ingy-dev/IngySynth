import { captureProject, applyDoc } from './save-capture.js';
import {
    LIBRARY_CAPS,
    docForKind,
    deleteEntry,
    listEntries,
    readSession,
    renameEntry,
    saveEntry,
    writeSession,
} from './save-library.js';
import { encodeLink } from './ingy/js/ingy-codec.js';
import {
    copyText,
    ingyFileBlob,
    probeCanShareFiles,
    resolveShareDelivery,
    runShareProject,
    triggerIngyDownload,
} from './save-share.js?v=3';

const HASH_LINK_RE = /(?:^|[&#])p=/;

let shareBusy = false;
let loadBusy = false;

function hashHasProjectLink() {
    return HASH_LINK_RE.test(location.hash);
}

function setText(el, text) {
    if (!el) return;
    el.textContent = text;
}

function persistStorageOnce() {
    if (navigator.storage?.persist) {
        navigator.storage.persist().catch(() => {});
    }
}

function scheduleSessionAutosave() {
    let timer = 0;
    const tick = () => {
        if (hashHasProjectLink()) return;
        try {
            writeSession(localStorage, captureProject());
        } catch {
            /* capture stub or quota */
        }
    };
    const debounced = () => {
        clearTimeout(timer);
        timer = setTimeout(tick, 4000);
    };
    document.addEventListener('ingysynth:sequencer-start', debounced);
    document.addEventListener('ingysynth:sequencer-stop', debounced);
    window.addEventListener('beforeunload', tick);
    debounced();
}

function restoreSessionIfAllowed() {
    if (hashHasProjectLink()) return;
    document.addEventListener('ingysynth:hash-project-applied', () => {}, { once: true });
    queueMicrotask(() => {
        if (hashHasProjectLink()) return;
        const doc = readSession(localStorage);
        if (doc) applyDoc(doc, 'project');
    });
}

function openSaveDialog(root) {
    root.hidden = false;
    document.body.classList.add('save-library-open');
    root.querySelector('[data-save-focus]')?.focus();
}

function closeSaveDialog(root) {
    root.hidden = true;
    document.body.classList.remove('save-library-open');
    document.getElementById('siteSave')?.focus();
}

function renderLibraryList(kind, listEl, statusEl) {
    if (!listEl) return;
    listEl.replaceChildren();
    const entries = listEntries(localStorage, kind);
    const cap = LIBRARY_CAPS[kind];
    const meta = document.createElement('p');
    meta.className = 'save-library-meta';
    meta.textContent = `${entries.length} / ${cap} slots (${kind})`;
    listEl.appendChild(meta);

    if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'save-library-empty';
        empty.textContent = 'No saves yet.';
        listEl.appendChild(empty);
        return;
    }

    for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'save-library-row';
        row.dataset.entryId = entry.id;

        const title = document.createElement('div');
        title.className = 'save-library-row-title';
        const nameLine = document.createElement('div');
        nameLine.className = 'save-library-name';
        setText(nameLine, entry.name);
        const byLine = document.createElement('div');
        byLine.className = 'save-library-by';
        setText(byLine, entry.by ? `by ${entry.by}` : '');
        title.append(nameLine, byLine);

        const actions = document.createElement('div');
        actions.className = 'save-library-row-actions';

        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'button';
        loadBtn.textContent = 'Load';
        loadBtn.disabled = loadBusy;
        loadBtn.addEventListener('click', () => {
            if (loadBusy) return;
            const ok = window.confirm(
                `Replace the current ${kind} with "${entry.name}"? Unsaved edits will be lost.`,
            );
            if (!ok) return;
            loadBusy = true;
            loadBtn.disabled = true;
            try {
                applyDoc(entry.doc, kind);
                setText(statusEl, `Loaded "${entry.name}".`);
                closeSaveDialog(document.getElementById('saveLibraryDialog'));
            } finally {
                loadBusy = false;
                loadBtn.disabled = false;
            }
        });

        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.className = 'button';
        renameBtn.textContent = 'Rename';
        renameBtn.addEventListener('click', () => {
            const name = window.prompt('Name', entry.name);
            if (name == null) return;
            const by = window.prompt('By', entry.by ?? '');
            if (by == null) return;
            renameEntry(localStorage, kind, entry.id, name, by);
            renderLibraryList(kind, listEl, statusEl);
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'button';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => {
            if (!window.confirm(`Delete "${entry.name}" from the library?`)) return;
            deleteEntry(localStorage, kind, entry.id);
            renderLibraryList(kind, listEl, statusEl);
        });

        actions.append(loadBtn, renameBtn, delBtn);
        row.append(title, actions);
        listEl.appendChild(row);
    }
}

export function initSaveLibraryUi() {
    persistStorageOnce();
    restoreSessionIfAllowed();
    scheduleSessionAutosave();

    const dialog = document.getElementById('saveLibraryDialog');
    const openBtn = document.getElementById('siteSave');
    const kindSelect = document.getElementById('saveLibraryKind');
    const listEl = document.getElementById('saveLibraryList');
    const statusEl = document.getElementById('saveLibraryStatus');
    const saveBtn = document.getElementById('saveLibrarySaveBtn');
    const closeBtn = document.getElementById('saveLibraryCloseBtn');
    const nudge = document.getElementById('saveLibraryNudge');

    if (nudge) {
        nudge.textContent = 'Add to Home Screen and use Share for backups — browser storage can be cleared after ~7 days on iOS.';
    }

    openBtn?.addEventListener('click', () => {
        const kind = kindSelect?.value || 'project';
        renderLibraryList(kind, listEl, statusEl);
        openSaveDialog(dialog);
    });

    kindSelect?.addEventListener('change', () => {
        renderLibraryList(kindSelect.value, listEl, statusEl);
    });

    saveBtn?.addEventListener('click', () => {
        const kind = kindSelect?.value || 'project';
        const captured = captureProject();
        const doc = docForKind(captured, kind);
        const result = saveEntry(localStorage, kind, doc);
        if (!result.ok && result.error === 'cap') {
            setText(statusEl, `Library full (${LIBRARY_CAPS[kind]} ${kind} slots). Delete one or share a file.`);
            return;
        }
        setText(statusEl, `Saved "${doc.name}".`);
        renderLibraryList(kind, listEl, statusEl);
    });

    closeBtn?.addEventListener('click', () => closeSaveDialog(dialog));
    dialog?.querySelectorAll('[data-save-dismiss]').forEach((el) => {
        el.addEventListener('click', () => closeSaveDialog(dialog));
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && dialog && !dialog.hidden) {
            closeSaveDialog(dialog);
        }
    });
}

function showShareStatus(status, message, url, offerCopy) {
    if (!status) return;
    status.replaceChildren(document.createTextNode(message));
    if (!offerCopy || !url) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'site-bar-share-copy';
    btn.textContent = 'Copy link';
    btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const ok = await copyText(url);
        btn.textContent = ok ? 'Copied' : 'Copy failed';
    });
    status.append(' ', btn);
}

async function deliverLinkAndFile(doc, link) {
    const url = link?.url || '';
    const copied = url ? await copyText(url) : false;
    triggerIngyDownload(doc, doc?.name);
    return {
        message: copied ? 'Link copied and file downloaded.' : 'File downloaded.',
        offerCopy: Boolean(url) && !copied,
        url,
    };
}

export async function handleSiteShare() {
    if (shareBusy) return;
    shareBusy = true;
    const status = document.getElementById('siteShareStatus');
    try {
        const doc = captureProject();
        const base = `${location.origin}${location.pathname}`;
        const link = await encodeLink(doc, base);
        const canShareFiles = await probeCanShareFiles();
        const hasWebShare = typeof navigator.share === 'function';
        const plan = resolveShareDelivery({ doc, link, canShareFiles, hasWebShare });
        const wantsSheet = plan.mode === 'share-url' || plan.mode === 'share-both' || plan.mode === 'share-file';

        if (wantsSheet) {
            try {
                await runShareProject({
                    doc,
                    link,
                    canShareFiles,
                    hasWebShare,
                    copyTextFn: copyText,
                    downloadFn: triggerIngyDownload,
                    shareFn: async ({ doc: shareDoc, link: shareLink, plan: sharePlan, fileName }) => {
                        const payload = { title: shareDoc.name || 'INGYSYNTH', text: shareDoc.by || 'INGYSYNTH project' };
                        if (sharePlan.mode === 'share-url' || sharePlan.mode === 'share-both') {
                            payload.url = shareLink.url;
                        }
                        if (sharePlan.mode === 'share-both' || sharePlan.mode === 'share-file') {
                            payload.files = [new File([ingyFileBlob(shareDoc)], fileName, { type: 'application/json' })];
                        }
                        await navigator.share(payload);
                    },
                });
                setText(status, 'Share ready.');
                return;
            } catch (err) {
                if (err?.name === 'AbortError') {
                    setText(status, '');
                    return;
                }
                const result = await deliverLinkAndFile(doc, link);
                showShareStatus(status, result.message, result.url, result.offerCopy);
                return;
            }
        }

        const copied = link?.url ? await copyText(link.url) : false;
        await runShareProject({
            doc,
            link,
            canShareFiles: false,
            hasWebShare: false,
            copyTextFn: async () => copied,
            downloadFn: triggerIngyDownload,
            shareFn: async () => {},
        });
        showShareStatus(
            status,
            copied ? 'Link copied and file downloaded.' : 'File downloaded.',
            link?.url || '',
            Boolean(link?.url) && !copied,
        );
    } catch (err) {
        setText(status, 'Share failed. Use Save, then share the file.');
    } finally {
        shareBusy = false;
    }
}

export function initSiteShare() {
    const btn = document.getElementById('siteShare');
    btn?.addEventListener('click', () => {
        handleSiteShare();
    });
}
