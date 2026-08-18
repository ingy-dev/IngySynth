#!/bin/sh
# CP11 static checks. Run from repo root.
# Exit 1 = leftover classic-id engine read, import-time step bus, or ghost HTML.

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

echo "== CP11 Phase B HTML (live index.html) =="
check_absent "ghost #synthContainer" 'id="synthContainer"' "index.html"
check_absent "ghost #cutoff" 'id="cutoff"' "index.html"
check_absent "ghost #startStop" 'id="startStop"' "index.html"
check_absent "ghost #mobileStartStop" 'id="mobileStartStop"' "index.html"
check_absent "ghost classic #oscilloscope" 'id="oscilloscope"' "index.html"
check_absent "ghost #logo-overlay" 'id="logo-overlay"' "index.html"
check_absent "ghost #stepParamBus" 'id="stepParamBus"' "index.html"
check_absent "ghost #swipeDots" 'id="swipeDots"' "index.html"
check_absent "ghost #osc4HarmonicsKnob" 'id="osc4HarmonicsKnob"' "index.html"
check_absent "ghost .header-grid" 'class="header-grid"' "index.html"
check_absent "ghost mobile start chrome" 'mobile-start-stop-container' "index.html"
check_absent "mobile.js import" "mobile\\.js" "js/main.js"
check_absent "cp10smoke loader" "cp10smoke|cp10-smoke" "js/main.js"
check_present "stage #kbOscilloscope" 'id="kbOscilloscope"' "index.html"
check_present "stage #kb-logo-overlay" 'id="kb-logo-overlay"' "index.html"
check_present "stage #kbStartStop" 'id="kbStartStop"' "index.html"
check_present "sr-only h1" 'class="sr-only"' "index.html"

echo
echo "== leftover classic getElementById (warn; optional chains on deleted nodes) =="
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
