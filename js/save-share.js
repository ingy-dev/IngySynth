import { serialize } from './ingy/js/ingy-codec.js';

/** Prefer .ingy file when the link is too long or a speech bank is present. */
export function docNeedsFileShare(doc, linkResult) {
    if (linkResult?.tooLong) return true;
    return Boolean(doc?.voice?.speechBank);
}

export function sanitizeIngyFileName(name) {
    const base = String(name ?? 'Untitled').trim() || 'Untitled';
    const stripped = base.replace(/[^\w\s.-]+/g, '').replace(/\s+/g, ' ').trim();
    const safe = (stripped || 'Untitled').slice(0, 64);
    return `${safe}.ingy`;
}

export function resolveShareDelivery({ doc, link, canShareFiles, hasWebShare }) {
    const forceFile = docNeedsFileShare(doc, link);
    if (forceFile) {
        if (hasWebShare && canShareFiles) {
            return { mode: 'share-file', url: link?.url ?? '', copyUrl: false, downloadFile: false };
        }
        return { mode: 'download-file', url: '', copyUrl: false, downloadFile: true };
    }
    if (hasWebShare && canShareFiles) {
        return { mode: 'share-both', url: link.url, copyUrl: false, downloadFile: false };
    }
    if (hasWebShare) {
        return { mode: 'share-url', url: link.url, copyUrl: false, downloadFile: false };
    }
    return { mode: 'copy-url-download-file', url: link.url, copyUrl: true, downloadFile: true };
}

export function ingyFileBlob(doc) {
    const text = serialize(doc, { pretty: true });
    return new Blob([text], { type: 'application/json' });
}

export function triggerIngyDownload(doc, fileName) {
    const blob = ingyFileBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeIngyFileName(fileName);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
    }
    return false;
}

export async function probeCanShareFiles() {
    if (typeof navigator.share !== 'function') return false;
    if (typeof navigator.canShare !== 'function') return false;
    try {
        const file = new File(['{}'], 'probe.ingy', { type: 'application/json' });
        return navigator.canShare({ files: [file] });
    } catch {
        return false;
    }
}

export async function runShareProject({ doc, link, canShareFiles, hasWebShare, copyTextFn, downloadFn, shareFn }) {
    const plan = resolveShareDelivery({ doc, link, canShareFiles, hasWebShare });
    const fileName = sanitizeIngyFileName(doc?.name);
    if (plan.copyUrl && plan.url) await copyTextFn(plan.url);
    if (plan.downloadFile) downloadFn(doc, fileName.replace(/\.ingy$/, ''));
    if (plan.mode === 'share-url' || plan.mode === 'share-both' || plan.mode === 'share-file') {
        await shareFn({ doc, link, plan, fileName });
    }
    return plan;
}
