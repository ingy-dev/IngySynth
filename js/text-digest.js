/**
 * A short fixed-length digest of a string (two 32-bit FNV-1a style passes, 16 hex chars).
 * Clips keep `copiedHash`/`keptHash` only to tell whether their source pad changed, so
 * they store this instead of the whole pattern as text.
 */
export function textDigest(text) {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ text.length;
    for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193);
        b = Math.imul(b ^ c, 0x5bd1e995);
        b ^= b >>> 15;
    }
    const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
    return hex(a) + hex(b);
}

/** Old files stored the full pattern text as the hash; shrink it to the digest it stands for. */
export function compactHash(hash) {
    if (typeof hash !== 'string' || hash.length <= 16) return hash ?? null;
    return textDigest(hash);
}
