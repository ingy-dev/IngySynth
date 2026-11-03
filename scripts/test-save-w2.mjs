#!/usr/bin/env node
/**
 * W2 save/library/share smoke tests.
 * Run: node scripts/test-save-w2.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as codec from '../js/ingy/js/ingy-codec.js';
import {
    LIBRARY_CAPS,
    createMemoryStorage,
    docForKind,
    listEntries,
    readLibrary,
    saveEntry,
} from '../js/save-library.js';
import {
    docNeedsFileShare,
    resolveShareDelivery,
    runShareProject,
} from '../js/save-share.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
    if (cond) {
        passed += 1;
        console.log(`  PASS  ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

console.log('save-library caps');
{
    const storage = createMemoryStorage();
    const doc = codec.makeDefault('patch');
    doc.name = 'Test patch';
    for (let i = 0; i < LIBRARY_CAPS.patch; i += 1) {
        const d = { ...doc, name: `Patch ${i}` };
        const r = saveEntry(storage, 'patch', d);
        ok(`save patch ${i + 1}`, r.ok);
    }
    const ninth = saveEntry(storage, 'patch', { ...doc, name: 'Patch 9' });
    ok('9th patch rejected', !ninth.ok && ninth.error === 'cap');
    ok('library holds 8 patches', readLibrary(storage).patch.length === 8);
    ok('listEntries patch count', listEntries(storage, 'patch').length === 8);
}

console.log('encodeLink huge doc');
{
    const text = readFileSync(join(root, 'js/ingy/examples/huge.ingy'), 'utf8');
    const parsed = codec.parse(text);
    ok('huge.ingy parses', parsed.ok);
    if (parsed.ok) {
        const link = await codec.encodeLink(parsed.doc, 'https://ingysynth.com/');
        ok('huge link tooLong', link.tooLong === true);
        ok('docNeedsFileShare when tooLong', docNeedsFileShare(parsed.doc, link));
    }
}

console.log('share fallback plan');
{
    const doc = codec.makeDefault('project');
    const link = { url: 'https://ingysynth.com/#p=abc', tooLong: false };
    const ff = resolveShareDelivery({
        doc,
        link,
        canShareFiles: false,
        hasWebShare: false,
    });
    ok('firefox desktop copy+download', ff.mode === 'copy-url-download-file' && ff.copyUrl && ff.downloadFile);

    const speechDoc = { ...doc, voice: { ...doc.voice, speechBank: { frames: [] } } };
    const filePlan = resolveShareDelivery({
        doc: speechDoc,
        link,
        canShareFiles: false,
        hasWebShare: true,
    });
    ok('speech bank forces download', filePlan.mode === 'download-file' && filePlan.downloadFile);

    let copied = '';
    let downloaded = false;
    let shared = false;
    await runShareProject({
        doc,
        link,
        canShareFiles: false,
        hasWebShare: false,
        copyTextFn: async (t) => { copied = t; return true; },
        downloadFn: () => { downloaded = true; },
        shareFn: async () => { shared = true; },
    });
    ok('runShareProject copies url', copied === link.url);
    ok('runShareProject downloads file', downloaded);
    ok('runShareProject skips web share on firefox plan', !shared);
}

console.log('docForKind normalize');
{
    const project = codec.makeDefault('project');
    project.name = 'Round';
    const patch = docForKind(project, 'patch');
    ok('patch kind', patch.kind === 'patch');
    ok('patch drops pattern slot fields', patch.pattern === undefined || patch.pattern?.slot === project.pattern?.slot);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
