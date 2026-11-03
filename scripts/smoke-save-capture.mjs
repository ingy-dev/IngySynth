#!/usr/bin/env node
/**
 * Save capture / apply smoke (W1).
 *   node scripts/smoke-save-capture.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as codec from '../js/ingy/js/ingy-codec.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

globalThis.window = globalThis;
globalThis.window.addEventListener = () => {};
globalThis.location = { hash: '', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };
const bodyClassList = { toggle() {}, add() {}, remove() {} };
globalThis.document = {
    body: { classList: bodyClassList },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById(id) {
        if (id === 'xAxisParam' || id === 'yAxisParam') {
            return { value: id === 'xAxisParam' ? 'cutoff' : 'resonance', dispatchEvent() {} };
        }
        if (id === 'bendRange') return { value: '2', dispatchEvent() {} };
        return null;
    },
};

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

const { captureProject, applyDoc, linkConfirmMessage, captureRoundTripCheck } = await import(
    pathToFileURL(join(root, 'js/save-capture.js')).href
);

console.log('save-capture smoke\n');

const captured = captureProject();
ok('captureProject returns kind project', captured.kind === 'project');
ok('captureProject codec round-trip', captureRoundTripCheck(captured));

const examplePath = join(root, 'js/ingy/examples/project-basic.ingy');
const exampleText = readFileSync(examplePath, 'utf8');
const parsed = codec.parse(exampleText);
ok('project-basic.ingy parses', parsed.ok);

if (parsed.ok) {
    applyDoc(parsed.doc, 'project');
    const again = captureProject();
    ok('applyDoc project-basic then capture round-trips', captureRoundTripCheck(again));
    ok(
        'musical tempo preserved after apply/capture',
        again.pattern?.params?.tempo === parsed.doc.pattern.params.tempo,
    );
}

const bomb = '<img src=x onerror=alert(1)>';
const msg = linkConfirmMessage({ name: bomb, by: bomb });
ok('malicious name is literal text in confirm message', msg.includes(bomb));

const linkJson = JSON.parse(readFileSync(join(root, 'js/ingy/links/project-basic.json'), 'utf8'));
const decoded = await codec.decodeLink(linkJson.url);
ok('project-basic link decodes', decoded.ok);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
