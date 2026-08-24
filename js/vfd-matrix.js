// Fixed 12-cell 5×7 dot-matrix VFD for the note readout.
// Distinct from the 16-segment sequencer DISP (vfd-charset.js).
// Each glyph is 7 row masks; bit 4 = leftmost column (0b10000).

export const NOTE_VFD_COLS = 12;
export const NOTE_VFD_ROWS = 7;
export const NOTE_VFD_DOT_COLS = 5;

/** @type {Record<string, number[]>} */
export const MATRIX_5X7 = {
    ' ': [0, 0, 0, 0, 0, 0, 0],
    '.': [
        0b00000,
        0b00000,
        0b00000,
        0b00000,
        0b00000,
        0b01100,
        0b01100,
    ],
    '+': [
        0b00000,
        0b00100,
        0b00100,
        0b11111,
        0b00100,
        0b00100,
        0b00000,
    ],
    '-': [
        0b00000,
        0b00000,
        0b00000,
        0b11111,
        0b00000,
        0b00000,
        0b00000,
    ],
    '#': [
        0b01010,
        0b01010,
        0b11111,
        0b01010,
        0b11111,
        0b01010,
        0b01010,
    ],
    // Cent sign for microtuning readouts
    '¢': [
        0b00100,
        0b01110,
        0b10101,
        0b10100,
        0b10101,
        0b01110,
        0b00100,
    ],
    '0': [
        0b01110,
        0b10001,
        0b10011,
        0b10101,
        0b11001,
        0b10001,
        0b01110,
    ],
    '1': [
        0b00100,
        0b01100,
        0b00100,
        0b00100,
        0b00100,
        0b00100,
        0b01110,
    ],
    '2': [
        0b01110,
        0b10001,
        0b00001,
        0b00010,
        0b00100,
        0b01000,
        0b11111,
    ],
    '3': [
        0b01110,
        0b10001,
        0b00001,
        0b00110,
        0b00001,
        0b10001,
        0b01110,
    ],
    '4': [
        0b00010,
        0b00110,
        0b01010,
        0b10010,
        0b11111,
        0b00010,
        0b00010,
    ],
    '5': [
        0b11111,
        0b10000,
        0b11110,
        0b00001,
        0b00001,
        0b10001,
        0b01110,
    ],
    '6': [
        0b00110,
        0b01000,
        0b10000,
        0b11110,
        0b10001,
        0b10001,
        0b01110,
    ],
    '7': [
        0b11111,
        0b00001,
        0b00010,
        0b00100,
        0b01000,
        0b01000,
        0b01000,
    ],
    '8': [
        0b01110,
        0b10001,
        0b10001,
        0b01110,
        0b10001,
        0b10001,
        0b01110,
    ],
    '9': [
        0b01110,
        0b10001,
        0b10001,
        0b01111,
        0b00001,
        0b00010,
        0b01100,
    ],
    A: [
        0b01110,
        0b10001,
        0b10001,
        0b11111,
        0b10001,
        0b10001,
        0b10001,
    ],
    B: [
        0b11110,
        0b10001,
        0b10001,
        0b11110,
        0b10001,
        0b10001,
        0b11110,
    ],
    C: [
        0b01110,
        0b10001,
        0b10000,
        0b10000,
        0b10000,
        0b10001,
        0b01110,
    ],
    D: [
        0b11110,
        0b10001,
        0b10001,
        0b10001,
        0b10001,
        0b10001,
        0b11110,
    ],
    E: [
        0b11111,
        0b10000,
        0b10000,
        0b11110,
        0b10000,
        0b10000,
        0b11111,
    ],
    F: [
        0b11111,
        0b10000,
        0b10000,
        0b11110,
        0b10000,
        0b10000,
        0b10000,
    ],
    G: [
        0b01110,
        0b10001,
        0b10000,
        0b10111,
        0b10001,
        0b10001,
        0b01110,
    ],
    N: [
        0b10001,
        0b11001,
        0b10101,
        0b10011,
        0b10001,
        0b10001,
        0b10001,
    ],
    O: [
        0b01110,
        0b10001,
        0b10001,
        0b10001,
        0b10001,
        0b10001,
        0b01110,
    ],
    T: [
        0b11111,
        0b00100,
        0b00100,
        0b00100,
        0b00100,
        0b00100,
        0b00100,
    ],
    // Lowercase for idle label "Note"
    o: [
        0b00000,
        0b00000,
        0b01110,
        0b10001,
        0b10001,
        0b10001,
        0b01110,
    ],
    t: [
        0b01000,
        0b01000,
        0b11110,
        0b01000,
        0b01000,
        0b01000,
        0b00110,
    ],
    e: [
        0b00000,
        0b00000,
        0b01110,
        0b10001,
        0b11111,
        0b10000,
        0b01110,
    ],
};

/** Center-pad (or truncate) to the fixed 12-cell screen width. */
export function padNoteVfdText(text) {
    const raw = String(text ?? '');
    if (raw.length >= NOTE_VFD_COLS) return raw.slice(0, NOTE_VFD_COLS);
    const pad = NOTE_VFD_COLS - raw.length;
    const left = Math.floor(pad / 2);
    return `${' '.repeat(left)}${raw}${' '.repeat(pad - left)}`;
}

function glyphForChar(ch) {
    if (Object.prototype.hasOwnProperty.call(MATRIX_5X7, ch)) return MATRIX_5X7[ch];
    const upper = ch.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(MATRIX_5X7, upper)) return MATRIX_5X7[upper];
    return MATRIX_5X7[' '];
}

/** Build the fixed 12×(5×7) DOM once inside a note-VFD host. */
export function ensureNoteVfd(host) {
    if (!host) return null;
    let charsEl = host.querySelector('.note-vfd-chars');
    if (charsEl?.dataset.ready === '1') return charsEl;

    host.classList.add('note-vfd');
    host.innerHTML = '';

    const bezel = document.createElement('div');
    bezel.className = 'note-vfd-bezel';

    const glass = document.createElement('div');
    glass.className = 'note-vfd-glass';

    charsEl = document.createElement('div');
    charsEl.className = 'note-vfd-chars';
    charsEl.setAttribute('aria-hidden', 'true');

    for (let c = 0; c < NOTE_VFD_COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'note-vfd-char';
        for (let d = 0; d < NOTE_VFD_ROWS * NOTE_VFD_DOT_COLS; d++) {
            cell.appendChild(document.createElement('i'));
        }
        charsEl.appendChild(cell);
    }

    glass.appendChild(charsEl);
    bezel.appendChild(glass);
    host.appendChild(bezel);
    charsEl.dataset.ready = '1';
    return charsEl;
}

/**
 * Paint a string onto a fixed 12-cell matrix VFD.
 * @param {HTMLElement|null} host
 * @param {string} text
 * @param {{ preview?: boolean }} [opts]
 */
export function renderNoteVfd(host, text, { preview = false } = {}) {
    const charsEl = ensureNoteVfd(host);
    if (!charsEl || !host) return;

    const next = String(text ?? '');
    const previewOn = !!preview;
    // Skip DOM work when nothing changed (important with multiple VFD hosts)
    if (
        host.dataset.text === next
        && host.classList.contains('note-vfd--preview') === previewOn
        && charsEl.dataset.painted === next
    ) {
        return;
    }

    const t0 = performance.now();
    host.classList.toggle('note-vfd--preview', previewOn);
    host.dataset.text = next;
    charsEl.dataset.painted = next;

    const padded = padNoteVfdText(text);
    const cells = charsEl.querySelectorAll('.note-vfd-char');
    cells.forEach((cell, i) => {
        const rows = glyphForChar(padded[i] ?? ' ');
        const dots = cell.querySelectorAll('i');
        dots.forEach((dot, di) => {
            const row = (di / NOTE_VFD_DOT_COLS) | 0;
            const col = di % NOTE_VFD_DOT_COLS;
            const on = ((rows[row] ?? 0) & (0b10000 >> col)) !== 0;
            dot.classList.toggle('on', on);
        });
    });
    const ms = performance.now() - t0;
    const p = (window.__ingyProf ||= {});
    p.vfdN = (p.vfdN || 0) + 1;
    if (ms > (p.vfdMax || 0)) p.vfdMax = ms;
}
