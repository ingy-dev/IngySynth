// Berlin functions other modules reach at call time, not import time.
// pattern-write.js importing berlin.js directly pulled store-engine.js in ahead
// of sequencer.js, so its start-up call into sequencer.js hit uninitialised
// state. This module imports nothing; berlin.js fills it in when it loads.

/** @type {{
 *   isBerlinOn?: () => boolean,
 *   berlinActiveRows?: () => number[],
 *   syncBerlinStep?: (row: number, step: number) => void,
 *   berlinLaneVfdLabel?: (row: number) => string,
 *   refreshBerlinSounding?: () => void,
 * }} */
export const berlinHooks = {};
