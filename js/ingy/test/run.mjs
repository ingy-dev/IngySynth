#!/usr/bin/env node
// Checks the JS reference codec against the shared test files.
//
//   node spec/ingy/test/run.mjs            check (exit 1 on any mismatch)
//   node spec/ingy/test/run.mjs --update   rewrite expected/ and links/ from the codec
//
// expected/<name>.json  : { ok, error, warnings, doc } for examples/<name>.ingy
// links/<name>.json     : { url, length, tooLong, decoded } for every ok example
// Every check here must also pass in C++ (tests/format, agent F0) and is cross-run by G.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as codec from '../js/ingy-codec.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const update = process.argv.includes('--update');
const BASE_URL = 'https://ingysynth.com/';

let failures = 0;
function check(cond, msg) {
    if (!cond) { failures++; console.error(`FAIL ${msg}`); }
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

mkdirSync(join(root, 'expected'), { recursive: true });
mkdirSync(join(root, 'links'), { recursive: true });

const names = readdirSync(join(root, 'examples')).filter((f) => f.endsWith('.ingy')).sort();

for (const file of names) {
    const name = basename(file, '.ingy');
    const text = readFileSync(join(root, 'examples', file), 'utf8');
    const result = codec.parse(text);
    const expectedPath = join(root, 'expected', `${name}.json`);
    // Stored with the document in minimal form; compare as parsed JSON (number formatting ignored).
    const stored = JSON.parse(JSON.stringify({ ...result, doc: result.doc && codec.minimize(result.doc) }));

    if (update) {
        writeFileSync(expectedPath, `${JSON.stringify(stored, null, 2)}\n`);
    } else {
        check(isDeepStrictEqual(stored, readJson(expectedPath)), `${name}: parse result differs from expected/${name}.json`);
    }

    if (!result.ok) continue;

    // Round trip: serialize -> parse gives the same document and no new warnings.
    const again = codec.parse(codec.serialize(result.doc));
    check(again.ok && isDeepStrictEqual(again.doc, result.doc), `${name}: serialize/parse round trip changed the document`);
    check(again.warnings.filter((w) => w !== 'newer:version').length === 0, `${name}: round trip produced warnings ${again.warnings}`);

    // Links: encode, decode, compare by content.
    const link = await codec.encodeLink(result.doc, BASE_URL);
    const decoded = await codec.decodeLink(link.url);
    check(decoded.ok, `${name}: link did not decode (${decoded.error})`);
    check(isDeepStrictEqual(decoded.doc, codec.linkDocument(result.doc)), `${name}: link decodes to a different document`);
    check(!JSON.stringify(decoded.doc).includes('"speechBank"'), `${name}: speech bank leaked into a link`);

    const linkPath = join(root, 'links', `${name}.json`);
    if (update) {
        writeFileSync(linkPath, `${JSON.stringify({ url: link.url, length: link.length, tooLong: link.tooLong, decoded: codec.minimize(decoded.doc) }, null, 2)}\n`);
    } else {
        // Stored links were made by an earlier run (or by C++); they must still decode to the stored doc.
        const stored = readJson(linkPath);
        const fromStored = await codec.decodeLink(stored.url);
        check(fromStored.ok && isDeepStrictEqual(codec.minimize(fromStored.doc), stored.decoded), `${name}: stored link no longer decodes to links/${name}.json`);
        check(stored.tooLong === link.tooLong, `${name}: tooLong changed (${stored.tooLong} -> ${link.tooLong})`);
    }
}

// Randomized round trip: normalize(minimize(doc)) must equal doc for any normalized doc.
// Catches defaults that depend on another field (like drum choke by model).
{
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 0x100000000; };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const models = ['open_hat', 'hihat', 'snare', 'bass_drum'];
    const step = () => (rand() < 0.5 ? null : {
        tune: Math.floor(rand() * 40) - 20, on: rand() < 0.5, accent: rand() < 0.3, ratch: 1 + Math.floor(rand() * 4),
        chord: rand() < 0.2 ? [3, 7] : [],
    });
    for (let iter = 0; iter < 300; iter++) {
        const raw = {
            format: 'ingysynth', version: 1, kind: 'project',
            voice: {
                params: { cutoff: pick([1000, 20, 10000, 555.5]), 'osc-type-2': pick(['sawtooth', 'sine']) },
                flags: {
                    drumKit: Array.from({ length: 4 }, () => (rand() < 0.3 ? null : {
                        model: pick(models), choke: rand() < 0.5, morphY: pick([0.5, 0.72, 0.1]), vol: pick([0.8, 0.3]),
                    })),
                },
            },
            pattern: {
                slots: Array.from({ length: 8 }, () => (rand() < 0.5 ? null : { stepCount: pick([8, 16]), steps: Array.from({ length: 32 }, step) })),
                drums: Array.from({ length: 8 }, () => (rand() < 0.6 ? null : { lanes: Array.from({ length: 4 }, () => ({ steps: Array.from({ length: 32 }, step) })) })),
                berlin: { slots: Array.from({ length: 8 }, () => ({ lanes: Array.from({ length: 8 }, () => ({ destination: pick(['cutoff', 'off', 'highpass']), amount: pick([1, 0.5]) })) })) },
            },
        };
        const first = codec.parse(JSON.stringify(raw));
        const again = codec.parse(codec.serialize(first.doc));
        if (!isDeepStrictEqual(first.doc, again.doc) || again.warnings.length) {
            check(false, `random round trip #${iter} changed the document`);
            break;
        }
    }
}

// Cases that are not files.
{
    const big = `{"format":"ingysynth","version":1,"kind":"patch","name":"${'x'.repeat(1024 * 1024)}"}`;
    check(codec.parse(big).error === 'too-large', 'file over 1 MB is rejected with too-large');

    const bomb = await (async () => {
        const text = `{"format":"ingysynth","version":1,"kind":"patch","pad":"${' '.repeat(2 * 1024 * 1024)}"}`;
        const s = new CompressionStream('deflate-raw');
        const w = s.writable.getWriter();
        w.write(new TextEncoder().encode(text));
        w.close();
        const bytes = new Uint8Array(await new Response(s.readable).arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    })();
    check(bomb.length < 6000, 'zip bomb payload is small');
    check((await codec.decodeLink(`#p=${bomb}`)).error === 'too-large', 'link inflating past 1 MB is rejected with too-large');
    check((await codec.decodeLink('#p=***')).error === 'bad-link', 'garbage link payload is rejected with bad-link');
    check((await codec.decodeLink('#p=AAAA')).error === 'bad-link', 'non-deflate payload is rejected with bad-link');
    check(codec.linkPayload('https://x.com/?a=1#p=abc&v=2') === 'abc', 'linkPayload finds p= among hash params');

    for (const kind of codec.KINDS) {
        const d = codec.makeDefault(kind);
        const again = codec.parse(codec.serialize(d));
        check(again.ok && again.warnings.length === 0 && isDeepStrictEqual(again.doc, d), `makeDefault(${kind}) round-trips with no warnings`);
    }
    // Minimal forms hide default mismatches (both sides drop "their" default), so the full
    // default project is stored once. It contains every voice, pattern and session default.
    const fullDefaultPath = join(root, 'expected', 'default-project.full.json');
    if (update) {
        writeFileSync(fullDefaultPath, `${codec.serialize(codec.makeDefault('project'), { full: true })}\n`);
    } else {
        check(isDeepStrictEqual(codec.makeDefault('project'), readJson(fullDefaultPath)), 'makeDefault(project) matches expected/default-project.full.json');
    }
    check(isDeepStrictEqual(codec.minimize(codec.makeDefault('project')), { format: 'ingysynth', version: 1, kind: 'project' }), 'minimal default project is just format/version/kind');
}

if (failures) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
}
console.log(`ok: ${names.length} examples${update ? ' (expected/ and links/ rewritten)' : ''}`);
