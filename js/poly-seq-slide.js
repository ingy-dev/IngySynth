/** Pair sequencer chord tones for poly slide / gliss-roll. No DOM. */

export const POLY_SEQ_PITCH_EPS = 1e-4;

export function sortedPolySeqIntervals(intervals) {
    const ivs = Array.isArray(intervals) && intervals.length ? intervals.slice() : [0];
    ivs.sort((a, b) => a - b);
    return ivs;
}

function pairRow(fromRoot, fromIntervals, toRoot, toIntervals, { padFromRoot = false } = {}) {
    const fromIvs = sortedPolySeqIntervals(fromIntervals);
    const toIvs = sortedPolySeqIntervals(toIntervals);
    const fr = Number(fromRoot) || 0;
    const tr = Number(toRoot) || 0;
    return toIvs.map((iv, i) => {
        const from = i < fromIvs.length
            ? fr + fromIvs[i]
            : (padFromRoot ? fr : tr + iv);
        const to = tr + iv;
        return {
            from,
            to,
            interval: iv,
            same: Math.abs(from - to) < POLY_SEQ_PITCH_EPS,
        };
    });
}

/** Destination chord: voice i slews from prevSorted[i] (or prev root if missing). */
export function pairPolySeqSlidePitches(prevRoot, prevIntervals, curRoot, curIntervals) {
    return pairRow(prevRoot, prevIntervals, curRoot, curIntervals, { padFromRoot: true });
}

/** This chord ramps toward next: extra this-tones hold; extra next-tones wait. */
export function pairPolySeqGlissPitches(thisRoot, thisIntervals, nextRoot, nextIntervals) {
    const a = sortedPolySeqIntervals(thisIntervals);
    const b = sortedPolySeqIntervals(nextIntervals);
    const tr = Number(thisRoot) || 0;
    const nr = Number(nextRoot) || 0;
    return a.map((iv, i) => {
        const from = tr + iv;
        const to = i < b.length ? nr + b[i] : from;
        return {
            from,
            to,
            interval: iv,
            same: Math.abs(from - to) < POLY_SEQ_PITCH_EPS,
        };
    });
}
