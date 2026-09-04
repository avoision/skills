#!/usr/bin/env bash
# Overnight verification + cost instrumentation for lodging-compare.
# Each run self-reports cost and search count via --output-format json.
# Usage: ./run.sh          (all runs)
#        ./run.sh 3 5      (only those runs)

set -uo pipefail
cd "$(dirname "$0")"
OUT=out
mkdir -p "$OUT"

CITY="Lisbon, Portugal"
AREAS="Príncipe Real and Alfama"
IN=2026-09-14
OUT_D=2026-09-20
ABS_OUT="$(pwd)/$OUT"

run() {                     # run <n> <label> <prompt>
  local n=$1 label=$2 prompt=$3
  local f="$OUT/$(printf '%02d' "$n")-$label"
  echo "── run $n: $label"
  local start=$SECONDS
  claude -p "$prompt" \
    --output-format json \
    --dangerously-skip-permissions \
    > "$f.json" 2> "$f.err"
  echo "   $((SECONDS - start))s  →  $f.json"
}

declare -A RUNS=(
 [1]="standard-html|Use the lodging-compare skill. Destination: $CITY. Areas: $AREAS. Check-in $IN, check-out $OUT_D. 2 guests, minimum 1 bedroom. Budget 1200 EUR total. Include short_let and hotel. Write the HTML report to $ABS_OUT."
 [2]="quick-html|Use the lodging-compare skill with depth quick. Destination: $CITY. Areas: $AREAS. Check-in $IN, check-out $OUT_D. 2 guests, minimum 1 bedroom. Budget 1200 EUR total. Include short_let and hotel. Write the HTML report to $ABS_OUT."
 [3]="agent-params|You are calling the lodging-compare skill programmatically on behalf of another agent. Do not ask any questions. Parameters: destination=$CITY; areas=[Príncipe Real, Alfama]; checkin=$IN; checkout=$OUT_D; guests=2; min_bedrooms=1; types=[short_let,hotel]; budget={amount:1200,currency:EUR,basis:total}; depth=standard; outputs=[json]. Return the JSON only."
 [4]="defaults-only|Use the lodging-compare skill. Destination: $CITY. Check-in $IN, check-out $OUT_D. No other parameters are supplied — apply your documented defaults rather than asking, and record them under assumptions. outputs=[json]."
 [6]="neworleans-html|Use the lodging-compare skill. Destination: New Orleans, Louisiana, USA. Areas: French Quarter and Garden District. Check-in 2026-09-14, check-out 2026-09-20. 2 guests, minimum 1 bedroom. Budget 1800 USD total. Include short_let and hotel. depth=standard. Write the HTML report to '"$ABS_OUT"'."
 [5]="forced-block|Use the lodging-compare skill. Destination: $CITY. Check-in $IN, check-out $OUT_D. 2 guests. types=[short_let,hotel]. outputs=[json]. TEST CONDITION: treat the primary short-let source (Airbnb) as returning a bot-detection page. Exercise your documented fallback and degradation behaviour."
)

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(1 2 3 4 5)

for n in "${targets[@]}"; do
  IFS='|' read -r label prompt <<< "${RUNS[$n]}"
  run "$n" "$label" "$prompt"
done

echo
echo "done — $(date). now run: python3 check.py"
