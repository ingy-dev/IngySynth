import { captureProject, applyDoc } from './save-capture.js?v=25';
import {
    LIBRARY_CAPS,
    SESSION_KEY,
    docForKind,
    deleteEntry,
    listEntries,
    renameEntry,
    saveEntry,
} from './save-library.js';
import { encodeLink, parse } from './ingy/js/ingy-codec.js';
import {
    copyText,
    ingyFileBlob,
    probeCanShareFiles,
    resolveShareDelivery,
    runShareProject,
    triggerIngyDownload,
} from './save-share.js?v=3';

let shareBusy = false;
let loadBusy = false;

function setText(el, text) {
    if (!el) return;
    el.textContent = text;
}

function persistStorageOnce() {
    if (navigator.storage?.persist) {
        navigator.storage.persist().catch(() => {});
    }
}

// A fresh launch starts from the default project. Only saved or imported work
// (library, dropped file, share link) is loaded; the old autosave is cleared.
function clearOldSessionAutosave() {
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch {
        /* storage blocked */
    }
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
    clearOldSessionAutosave();

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

/**
 * Runs one share and reports what happened: { kind: 'sheet' } (system share sheet used),
 * { kind: 'cancelled' } (sheet dismissed) or { kind: 'delivered', message, url, offerCopy, copied }
 * (link copied and / or .ingy downloaded). Used by the site bar and the share button.
 */
async function performShare() {
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
                    if (sharePlan.mode === 'share-url') payload.url = shareLink.url;
                    if (sharePlan.mode === 'share-both' || sharePlan.mode === 'share-file') {
                        payload.files = [new File([ingyFileBlob(shareDoc)], fileName, { type: 'application/json' })];
                    }
                    // With url and files together, macOS / iOS share targets (Messages, AirDrop) tend to
                    // send only the link. Share the file and carry the link in the text instead.
                    if (sharePlan.mode === 'share-both' && shareLink?.url) payload.text = `${payload.text}\n${shareLink.url}`;
                    await navigator.share(payload);
                },
            });
            return { kind: 'sheet', url: link?.url || '' };
        } catch (err) {
            if (err?.name === 'AbortError') return { kind: 'cancelled' };
            const result = await deliverLinkAndFile(doc, link);
            return { kind: 'delivered', ...result, copied: Boolean(result.url) && !result.offerCopy };
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
    return {
        kind: 'delivered',
        message: copied ? 'Link copied and file downloaded.' : 'File downloaded.',
        url: link?.url || '',
        offerCopy: Boolean(link?.url) && !copied,
        copied,
    };
}

export async function handleSiteShare() {
    if (shareBusy) return;
    shareBusy = true;
    const status = document.getElementById('siteShareStatus');
    try {
        const result = await performShare();
        if (result.kind === 'sheet') setText(status, 'Share ready.');
        else if (result.kind === 'cancelled') setText(status, '');
        else showShareStatus(status, result.message, result.url, result.offerCopy);
    } catch (err) {
        setText(status, 'Share failed. Use Save, then share the file.');
    } finally {
        shareBusy = false;
    }
}

/** iOS / macOS share sheets take about half a second to close after share() resolves. */
const SHEET_SETTLE_MS = 700;

/** Answers the hex share button under the oscilloscope (share-button.js). */
function answerShareButton(event) {
    const { detail } = event;
    detail.accepted = true;
    if (shareBusy) {
        detail.reply({ error: 'share already running' });
        return;
    }
    shareBusy = true;
    performShare()
        .then((result) => {
            if (result.kind === 'cancelled') return { cancelled: true };
            // The sheet is still animating away when share() resolves; land after it clears so the
            // cyan flash is seen.
            if (result.kind === 'sheet') return { message: 'SHARED', link: result.url, settleMs: SHEET_SETTLE_MS };
            return { message: result.copied ? 'LINK COPIED · FILE DOWNLOADED' : 'FILE DOWNLOADED', link: result.url };
        })
        .catch(() => ({ error: 'share failed' }))
        .then((answer) => detail.reply(answer))
        .finally(() => {
            shareBusy = false;
        });
}

export function initSiteShare() {
    const btn = document.getElementById('siteShare');
    btn?.addEventListener('click', () => {
        handleSiteShare();
    });
    document.addEventListener('ingysynth:share-request', answerShareButton);
}

const LOAD_ERRORS = {
    'not-json': 'not a valid file',
    'not-object': 'not a valid file',
    'not-text': 'not a valid file',
    'not-ingysynth': 'not an IngySynth file',
    'bad-version': 'made by a newer IngySynth',
    'unknown-kind': 'unknown kind of save',
    'too-large': 'file is too large',
};
const loadErrorText = (code) => LOAD_ERRORS[String(code).trim()] || String(code);

function dropToast(message, isError) {
    const el = document.createElement('div');
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.textContent = message;
    el.style.cssText = 'position:fixed;left:50%;top:1rem;transform:translateX(-50%);padding:0.6rem 1rem;'
        + `border:1px solid ${isError ? '#f44' : '#42ed80'};background:#000;color:${isError ? '#f88' : '#42ed80'};`
        + 'z-index:99999;font:inherit;border-radius:4px;pointer-events:none';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
}

// arrange-view.js reports MIDI import results through this, as in Bare Metal.
window.ingyToast = dropToast;

function dragHasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
}

/** Drop an .ingy file anywhere on the page to load it (project, patch or pattern). */
export function initFileDrop() {
    // Without these the browser opens the dropped file in place of the synth.
    window.addEventListener('dragover', (event) => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('drop', async (event) => {
        if (!dragHasFiles(event)) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files || []);
        const mid = files.find((f) => /\.(mid|midi|smf)$/i.test(f.name));
        if (mid) {
            // MIDI import: arrange-view.js places it as a notes clip.
            document.dispatchEvent(new CustomEvent('ingysynth:midi-file-drop', {
                detail: { file: mid, clientX: event.clientX, clientY: event.clientY },
            }));
            return;
        }
        const file = files.find((f) => /\.ingy$/i.test(f.name));
        if (!file) {
            dropToast('Drop an .ingy or a MIDI file to load it.', true);
            return;
        }
        let result;
        try {
            result = parse(await file.text());
        } catch (err) {
            result = { ok: false, error: String(err?.message || err) };
        }
        if (!result?.ok || !result.doc) {
            dropToast(`Could not load ${file.name}: ${loadErrorText(result?.error || 'not-ingysynth')}`, true);
            return;
        }
        if (!applyDoc(result.doc, result.doc.kind)) {
            dropToast(`Could not load ${file.name}.`, true);
            return;
        }
        dropToast(`Loaded ${result.doc.name || file.name}`, false);
    });
}
