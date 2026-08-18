#!/bin/sh
# CP11 Phase A static checks. Run from repo root.
# Exit 1 = leftover classic-id engine read or import-time step bus.

set -e
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
fail=0

check_absent() {
    label=$1
    pattern=$2
    file=$3
    if grep -nE "$pattern" "$file" >/dev/null 2>&1; then
        echo "FAIL $label"
        grep -nE "$pattern" "$file" || true
        fail=1
    else
        echo "OK   $label"
    fi
}

check_present() {
    label=$1
    pattern=$2
    file=$3
    if grep -nE "$pattern" "$file" >/dev/null 2>&1; then
        echo "OK   $label"
    else
        echo "FAIL $label (expected to match)"
        fail=1
    fi
}

echo "== CP11 Phase A static =="
check_absent "write stepCount from DOM" "getElementById\\('stepCount'\\)" "js/pattern-write.js"
check_absent "shift stepCount from DOM" "getElementById\\('stepCount'\\)" "js/pattern-shift.js"
check_absent "keyboard-steps stepCount from DOM" "getElementById\\('stepCount'\\)" "js/keyboard-steps.js"
check_absent "acid noiseVol from DOM" "getElementById\\('noiseVol'\\)" "js/keyboard-acid-strip.js"
check_absent "tuning scaleToggle from DOM" "getElementById\\('scaleToggle'\\)" "js/tuning.js"
check_absent "tuning scaleSelect from DOM" "getElementById\\('scaleSelect'\\)" "js/tuning.js"
check_absent "sequencer scaleToggle from DOM" "getElementById\\('scaleToggle'\\)" "js/sequencer.js"
check_absent "sequencer scaleSelect from DOM" "getElementById\\('scaleSelect'\\)" "js/sequencer.js"
check_absent "import-time ensureStepParamBus" "ensureStepParamBus" "js/sequencer.js"
check_absent "create #stepParamBus" "id = 'stepParamBus'|id=.stepParamBus." "js/sequencer.js"
check_absent "classic osc4HarmonicsKnob binding" "dialId: 'osc4HarmonicsKnob'" "js/knobs.js"
check_absent "write setStepTune classic dispatch" "querySelector\\(.*\\.step-tune" "js/pattern-write.js"
check_present "bindKnob allows key without classic input" "\\(!key && !input\\)" "js/knobs.js"
check_absent "bindKnob must not early-return on !key" "if \\(!key\\) return" "js/knobs.js"

echo
echo "== leftover classic getElementById (warn; Phase B deletes the nodes) =="
if grep -nE "getElementById\\('(startStop|cutoff|stepCount|noiseVol|scaleToggle|scaleSelect)'\\)" js/*.js >/dev/null 2>&1; then
    grep -nE "getElementById\\('(startStop|cutoff|stepCount|noiseVol|scaleToggle|scaleSelect)'\\)" js/*.js || true
else
    echo "OK   no remaining classic-id getElementById in js/"
fi

echo
if [ "$fail" -ne 0 ]; then
    echo "CP11 static FAILED"
    exit 1
fi
echo "CP11 static passed"
exit 0
