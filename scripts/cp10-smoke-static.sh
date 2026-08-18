#!/bin/sh
# CP10 static checks (bind-at-boot / one engine path). Run from repo root.
# Exit 1 = CP10 grep fail. WARN lines are CP11 leftovers, not this gate.

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

echo "== CP10 static =="
check_absent "params.set must not dispatchEvent" "dispatchEvent\\(" "js/params.js"
check_absent "LFO RATE must not early-return on missing hz/sync inputs" "if \(!hzInput \|\| !syncInput\) return" "js/lfo-rate.js"
check_present "bindKnob allows key without classic input" "\\(!key && !input\\)" "js/knobs.js"

echo
echo "== CP11 leftovers (warn only) =="
for spec in \
    "js/pattern-write.js|getElementById('stepCount')" \
    "js/pattern-shift.js|getElementById('stepCount')" \
    "js/keyboard-acid-strip.js|getElementById('noiseVol')" \
    "js/tuning.js|getElementById('scaleToggle')" \
    "js/sequencer.js|getElementById('scaleToggle')"
do
    file=${spec%%|*}
    pat=${spec#*|}
    if grep -n "$pat" "$file" >/dev/null 2>&1; then
        echo "WARN $file still references $pat"
    else
        echo "OK   $file no longer references $pat"
    fi
done

echo
if [ "$fail" -ne 0 ]; then
    echo "CP10 static FAILED"
    exit 1
fi
echo "CP10 static passed"
exit 0
