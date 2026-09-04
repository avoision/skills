#!/usr/bin/env bash
# Does ANY evasion technique get listings out of Airbnb from this machine?
# Escalates: bare → dwell → dwell+scroll → full human-ish. Reports per tier.
cd "$(dirname "$0")"
URL='https://www.airbnb.com/s/Lisbon--Portugal/homes?checkin=2026-09-14&checkout=2026-09-20&adults=2'
P=playwright-cli

probe() {   # probe <tier-name>
  local out
  out=$($P eval "() => {
    const cards = document.querySelectorAll('[data-testid=\"card-container\"]').length;
    const items = document.querySelectorAll('[itemprop=\"itemListElement\"]').length;
    const t = (document.body.innerText||'').slice(0,4000).toLowerCase();
    const blocked = ['unusual traffic','are you a robot','captcha','access denied',
                     'verify you are','something went wrong'].filter(s=>t.includes(s));
    return JSON.stringify({title:document.title.slice(0,70), cards, items,
                           blocked, chars:(document.body.innerText||'').length});
  }" 2>&1 | tail -5)
  printf '  %-26s %s\n' "$1" "$out"
}

echo "── T1  bare: open + read immediately"
$P close >/dev/null 2>&1
$P open "$URL" >/dev/null 2>&1
probe "T1 bare"

echo "── T2  dwell 10s"
$P goto "$URL" >/dev/null 2>&1; sleep 10; probe "T2 dwell-10s"

echo "── T3  dwell 30s + scroll"
$P goto "$URL" >/dev/null 2>&1; sleep 30
$P mousewheel 0 600 >/dev/null 2>&1; sleep 3
$P mousewheel 0 600 >/dev/null 2>&1; sleep 3
probe "T3 dwell-30s+scroll"

echo "── T4  resize + mouse + long dwell + repeated scroll"
$P resize 1440 900 >/dev/null 2>&1
$P goto "$URL" >/dev/null 2>&1; sleep 15
for x in 300 700 1100; do $P mousemove $x 400 >/dev/null 2>&1; sleep 2; done
for i in 1 2 3 4; do $P mousewheel 0 500 >/dev/null 2>&1; sleep 4; done
sleep 15
probe "T4 full"
$P screenshot >/dev/null 2>&1 && echo "  (screenshot saved by playwright-cli)"

$P close >/dev/null 2>&1
echo "done"
