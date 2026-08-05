// 16-segment VFD character set from Wikimedia 16SegmentDisplayASCII.svg
// Segments: a1 a2 b c d1 d2 e f g1 g2 h i j k l m (+ dp decimal point)
// Mixed-case helper prefers the more legible glyph for brand/text scroll.

export const VFD_SEGMENTS = [
    'a1','a2','b','c','d1','d2','e','f','g1','g2','h','i','j','k','l','m','dp',
];

/** @type {Record<string, string[]>} */
export const VFD_CHARSET = {
    " ": [],
    "!": ["b", "c", "dp"],
    "\"": ["b", "f"],
    "#": ["d1", "d2", "e", "f", "g1", "g2", "i", "l"],
    "$": ["a1", "a2", "c", "d1", "d2", "f", "g1", "g2", "i", "l"],
    "%": ["a1", "c", "d2", "f", "g1", "g2", "i", "j", "k", "l"],
    "&": ["a1", "d1", "d2", "e", "f", "g1", "h", "j", "m"],
    "'": ["b"],
    "(": ["j", "m"],
    ")": ["h", "k"],
    "*": ["g1", "g2", "h", "i", "j", "k", "l", "m"],
    "+": ["g1", "g2", "i", "l"],
    ",": ["d1"],
    "-": ["g1", "g2"],
    ".": ["dp"],
    "/": ["j", "k"],
    "0": ["a1", "a2", "b", "c", "d1", "d2", "e", "f"],
    "1": ["b", "c"],
    "2": ["a1", "a2", "b", "d1", "d2", "e", "g1", "g2"],
    "3": ["a1", "a2", "b", "c", "d1", "d2", "g1", "g2"],
    "4": ["b", "c", "f", "g1", "g2"],
    "5": ["a1", "a2", "c", "d1", "d2", "f", "g1", "g2"],
    "6": ["a1", "a2", "c", "d1", "d2", "e", "f", "g1", "g2"],
    "7": ["a1", "a2", "b", "c"],
    "8": ["a1", "a2", "b", "c", "d1", "d2", "e", "f", "g1", "g2"],
    "9": ["a1", "a2", "b", "c", "d1", "d2", "f", "g1", "g2"],
    ":": ["g1", "d1"],
    ";": ["a1", "k"],
    "<": ["j", "m"],
    "=": ["d1", "d2", "g1", "g2"],
    ">": ["h", "k"],
    "?": ["a2", "b", "g2", "l", "dp"],
    "@": ["a1", "a2", "b", "c", "d1", "d2", "e", "g1", "l"],
    "A": ["a1", "a2", "b", "c", "e", "f", "g1", "g2"],
    "B": ["a1", "a2", "b", "c", "d1", "d2", "g2", "i", "l"],
    "C": ["a1", "a2", "d1", "d2", "e", "f"],
    "D": ["a1", "a2", "b", "c", "d1", "d2", "i", "l"],
    "E": ["a1", "a2", "d1", "d2", "e", "f", "g1"],
    "F": ["a1", "a2", "e", "f", "g1"],
    "G": ["a1", "a2", "c", "d1", "d2", "e", "f", "g2"],
    "H": ["b", "c", "e", "f", "g1", "g2"],
    "I": ["a1", "a2", "d1", "d2", "i", "l"],
    "J": ["b", "c", "d1", "d2", "e"],
    "K": ["e", "f", "g1", "j", "m"],
    "L": ["d1", "d2", "e", "f"],
    "M": ["b", "c", "e", "f", "h", "j"],
    "N": ["b", "c", "e", "f", "h", "m"],
    "O": ["a1", "a2", "b", "c", "d1", "d2", "e", "f"],
    "P": ["a1", "a2", "b", "e", "f", "g1", "g2"],
    "Q": ["a1", "a2", "b", "c", "d1", "d2", "e", "f", "m"],
    "R": ["a1", "a2", "b", "e", "f", "g1", "g2", "m"],
    "S": ["a1", "a2", "c", "d1", "d2", "f", "g1", "g2"],
    "T": ["a1", "a2", "i", "l"],
    "U": ["b", "c", "d1", "d2", "e", "f"],
    "V": ["e", "f", "j", "k"],
    "W": ["b", "c", "e", "f", "k", "m"],
    "X": ["h", "j", "k", "m"],
    "Y": ["h", "j", "l"],
    "Z": ["a1", "a2", "d1", "d2", "j", "k"],
    "[": ["a2", "d2", "i", "l"],
    "\\": ["h", "m"],
    "]": ["a1", "d1", "i", "l"],
    "^": ["k", "m"],
    "_": ["d1", "d2"],
    "`": ["h"],
    "a": ["d1", "d2", "e", "g1", "l"],
    "b": ["c", "d1", "d2", "e", "f", "g1", "g2"],
    "c": ["d1", "d2", "e", "g1", "g2"],
    "d": ["b", "c", "d1", "d2", "e", "g1", "g2"],
    "e": ["d1", "d2", "e", "g1", "k"],
    "f": ["a2", "g1", "g2", "i", "l"],
    "g": ["d2", "e", "g1", "k", "m"],
    "h": ["c", "e", "f", "g1", "g2"],
    "i": ["a1", "d1", "d2", "g1", "l"],
    "j": ["a2", "c", "d1", "d2", "g2"],
    "k": ["e", "f", "j", "m"],
    "l": ["a1", "d2", "i", "l"],
    "m": ["c", "e", "g1", "g2", "l"],
    "n": ["c", "e", "g1", "g2"],
    "o": ["c", "d1", "d2", "e", "g1", "g2"],
    "p": ["c", "d1", "g2", "l", "m"],
    "q": ["c", "d1", "d2", "e", "g1", "g2", "m"],
    "r": ["e", "g1", "g2"],
    "s": ["d1", "d2", "g2", "m"],
    "t": ["d2", "g1", "g2", "i", "l"],
    "u": ["c", "d1", "d2", "e"],
    "v": ["e", "k"],
    "w": ["c", "e", "k", "m"],
    "x": ["g1", "g2", "k", "m"],
    "y": ["c", "d1", "d2", "m"],
    "z": ["d1", "g1", "k"],
    "{": ["a2", "d2", "g1", "i", "l"],
    "|": ["i", "l"],
    "}": ["a1", "d1", "g2", "i", "l"],
    "~": ["f", "h", "j"],
};

// Preferred glyphs for brand scroll (mixed case for legibility)
export const VFD_BRAND_SCROLL = '  InGYSYnth.  ';

/** Brand-scroll-only glyph tweaks (does not affect step-number digits). */
export const VFD_BRAND_OVERRIDES = {
    // Capital Y with bottom bar (brand scroll only)
    'Y': ['b', 'c', 'd1', 'd2', 'f', 'g1', 'g2'],
};

export function vfdSegmentsForChar(ch, { brand = false } = {}) {
    if (ch == null || ch === '') return [];
    if (brand && Object.prototype.hasOwnProperty.call(VFD_BRAND_OVERRIDES, ch)) {
        return VFD_BRAND_OVERRIDES[ch];
    }
    if (Object.prototype.hasOwnProperty.call(VFD_CHARSET, ch)) return VFD_CHARSET[ch];
    const upper = ch.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(VFD_CHARSET, upper)) return VFD_CHARSET[upper];
    const lower = ch.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(VFD_CHARSET, lower)) return VFD_CHARSET[lower];
    return [];
}

export function applyVfdChar(digitEl, ch, { brand = false } = {}) {
    if (!digitEl) return;
    const glyph = ch === ' ' ? ' ' : ch;
    digitEl.dataset.digit = glyph === ' ' ? 'sp' : glyph;
    const on = new Set(vfdSegmentsForChar(glyph, { brand }));
    digitEl.querySelectorAll('.seg').forEach((seg) => {
        const name = [...seg.classList].find((c) => c !== 'seg' && c !== 'on');
        seg.classList.toggle('on', name ? on.has(name) : false);
    });
}
