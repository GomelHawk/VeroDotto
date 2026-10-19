#!/usr/bin/env bash
# VeroDotto's real conversions: uv, Python and every converter for real, on this OS.
# Needs the network once (setup downloads uv and the converters); CI runs it on Linux,
# macOS and Windows.
#
#   tests/convert.sh                  setup from scratch into a temporary VERODOTTO_DIR
#   VERODOTTO_DIR=dir tests/convert.sh   reuse a set-up cache (faster, local runs)
#
# Each fixture in tests/fixtures converts, and its markdown contains every line of
# <name>.expect and none of <name>.reject: loose matching, robust to whitespace changes
# between pinned versions. Plus: the scan is kept, the big sheet is summarised, a second
# run is served from the cache, and nothing lands outside the cache directory.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VD="$ROOT/plugins/vero-dotto/scripts/verodotto.sh"
FIX="$ROOT/tests/fixtures"

WORK="$(mktemp -d 2>/dev/null || mktemp -d -t verodotto)"
trap 'rm -rf "$WORK"' EXIT
[ -n "${VERODOTTO_DIR:-}" ] || export VERODOTTO_DIR="$WORK/cache"
# Isolation: everything runs with an empty home folder, which must still be empty at the
# end - no uv config, no Python linked into ~/.local/bin, no cache outside VERODOTTO_DIR.
mkdir -p "$WORK/home"
export HOME="$WORK/home"
unset XDG_CACHE_HOME XDG_DATA_HOME XDG_CONFIG_HOME XDG_BIN_HOME

pass=0 fail=0
ok()   { pass=$((pass+1)); printf '  \033[32mok\033[0m    %s\n' "$1"; }
no()   { fail=$((fail+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }

echo "== setup =="
if out="$(bash "$VD" setup 2>&1)"; then ok "setup: $(printf '%s' "$out" | tail -n 1)"; else no "setup" "$out"; exit 1; fi
status="$(bash "$VD" status | head -n 1)"
[ "$status" = ready ] && ok "status says ready" || no "status says ready" "got $status"

# The folder and the meta of one conversion: line 1 is "<dir>TAB<cached|new>".
convert() { bash "$VD" convert "$FIX/$1" 2>/dev/null; }
md_of() { local dir; dir="$(printf '%s' "$1" | head -n 1 | cut -f1)"; command -v cygpath >/dev/null 2>&1 && dir="$(cygpath -u "$dir")"; cat "$dir/doc.md"; }

echo
echo "== every fixture =="
for f in "$FIX"/*; do
  case "$f" in *.expect|*.reject) continue ;; esac
  name="$(basename "$f")"
  if ! out="$(convert "$name")"; then no "$name converts" "verodotto.sh convert failed"; continue; fi
  md="$(md_of "$out")"
  missing=""
  while IFS= read -r want; do
    [ -n "$want" ] || continue
    printf '%s' "$md" | grep -qF -- "$want" || missing="$missing [$want]"
  done < "$f.expect"
  found=""
  while IFS= read -r bad; do
    [ -n "$bad" ] || continue
    if [ "$bad" = $'\r' ]; then printf '%s' "$md" | grep -q $'\r' && found="$found [CR]"; continue; fi
    printf '%s' "$md" | grep -qF -- "$bad" && found="$found [$bad]"
  done < "$f.reject"
  if [ -z "$missing$found" ]; then ok "$name"; else no "$name" "missing:${missing:- none}; unwanted:${found:- none}"; fi
done

echo
echo "== decisions =="
meta="$(convert scan.pdf | sed -n 2p)"
printf '%s' "$meta" | grep -q '"keep": *"little-text"' && ok "a scanned PDF is kept as the original" \
  || no "a scanned PDF is kept as the original" "$meta"
meta="$(convert big.xlsx | sed -n 2p)"
printf '%s' "$meta" | grep -q '"kind": *"summary"' && ok "a big sheet is summarised" || no "a big sheet is summarised" "$meta"
meta="$(convert book.xlsx | sed -n 2p)"
printf '%s' "$meta" | grep -q '"kind": *"full"' && ok "a small sheet is converted in full" || no "a small sheet is converted in full" "$meta"
printf '%s' "$meta" | grep -q '1 formula with no saved result (formula shown)' && ok "a formula with no saved result is named as such" \
  || no "a formula with no saved result is named as such" "$meta"
meta="$(convert spec.docx | sed -n 2p)"
printf '%s' "$meta" | grep -q '1 image' && ok "an image is named among the losses" || no "an image is named among the losses" "$meta"
lat="$(convert spec.docx | sed -n 2p | grep -o '"mdChars": *[0-9]*' | grep -o '[0-9]*$')"
latt="$(convert spec.docx | sed -n 2p | grep -o '"mdTokens": *[0-9]*' | grep -o '[0-9]*$')"
cyr="$(convert cyrillic.docx | sed -n 2p | grep -o '"mdChars": *[0-9]*' | grep -o '[0-9]*$')"
cyrt="$(convert cyrillic.docx | sed -n 2p | grep -o '"mdTokens": *[0-9]*' | grep -o '[0-9]*$')"
[ $((latt * 4)) -ge "$lat" ] && [ $((cyrt * 3)) -ge "$cyr" ] && [ $((cyrt * 4)) -gt "$cyr" ] \
  && ok "Cyrillic text is estimated at 3 characters a token, Latin at 4" \
  || no "Cyrillic text is estimated at 3 characters a token, Latin at 4" "latin $lat/$latt cyrillic $cyr/$cyrt"

echo
echo "== cache =="
start="$(date +%s)"
first="$(convert spec.docx | head -n 1)"
end="$(date +%s)"
case "$first" in *$'\t'cached) ok "a second conversion is served from the cache" ;; *) no "a second conversion is served from the cache" "$first" ;; esac
[ $((end - start)) -le 1 ] && ok "and takes under a second" || no "and takes under a second" "$((end - start)) s"

echo
echo "== isolation =="
left="$(find "$HOME" -mindepth 1 2>/dev/null | head -n 5)"
[ -z "$left" ] && ok "nothing was written to the home folder" || no "nothing was written to the home folder" "$left"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
