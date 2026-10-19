#!/usr/bin/env bash
# VeroDotto smoke test. No Claude Code, no network, no credentials - bash, coreutils and a
# fake `uv` on PATH that writes canned markdown, so it runs identically on a developer's
# machine and on a CI runner.
#
#   tests/smoke.sh
#
# It guards the promises verodotto.sh makes: where the cache is, when setup counts as
# done, that conversions are cached by content, that cleaning never touches the
# converters, that purge refuses an odd path, that uv never sees an inherited Python
# environment. The real converters run in tests/convert.sh; the module's own logic is
# TypeScript, tested by `claude plugin test ./plugins/vero-dotto`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VD="$ROOT/plugins/vero-dotto/scripts/verodotto.sh"
PLUGIN="$ROOT/plugins/vero-dotto"

WORK="$(mktemp -d 2>/dev/null || mktemp -d -t verodotto)"
trap 'rm -rf "$WORK"' EXIT
unset XDG_CACHE_HOME
export VERODOTTO_DIR="$WORK/cache"

pass=0 fail=0
ok()   { pass=$((pass+1)); printf '  \033[32mok\033[0m    %s\n' "$1"; }
no()   { fail=$((fail+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "expected '$3', got '$2'"; fi; }
has()  { if printf '%s' "$2" | grep -q -- "$3"; then ok "$1"; else no "$1" "missing '$3' in: $2"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q -- "$3"; then no "$1" "found '$3'"; else ok "$1"; fi; }

echo "== repository hygiene =="

SCRIPTS="install.sh uninstall.sh tests/smoke.sh tests/convert.sh plugins/vero-dotto/scripts/verodotto.sh"
for f in $SCRIPTS; do
  [ -x "$ROOT/$f" ] && ok "executable: $f" || no "executable: $f" "not +x - it will not run once cloned"
  if grep -q $'\r$' "$ROOT/$f"; then
    no "LF endings: $f" "CRLF found - dies with: /usr/bin/env: 'bash\\r': No such file or directory"
  else
    ok "LF endings: $f"
  fi
done

for f in plugins/vero-dotto/.claude-plugin/plugin.json plugins/vero-dotto/hooks/hooks.json; do
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$ROOT/$f" 2>/dev/null; then
    ok "valid JSON: $f"
  else
    no "valid JSON: $f"
  fi
done

# macOS still ships bash 3.2 as /bin/bash. `mapfile`/`readarray` and a fractional
# `read -t` are bash 4+. (This file names them itself, so it is not checked.)
for f in install.sh uninstall.sh tests/convert.sh plugins/vero-dotto/scripts/verodotto.sh; do
  if grep -qE '^[^#]*\b(mapfile|readarray)\b' "$ROOT/$f"; then
    no "no bash 4+ syntax: $f" "mapfile/readarray needs bash 4; macOS ships 3.2"
  elif grep -qE '^[^#]*read\b.*-t +[0-9]*\.[0-9]' "$ROOT/$f"; then
    no "no bash 4+ syntax: $f" "fractional 'read -t' needs bash 4"
  else
    ok "no bash 4+ syntax: $f"
  fi
done

if python3 -c 'import json,sys; sys.exit(1 if "hooks" in json.load(open(sys.argv[1])) else 0)' \
     "$PLUGIN/.claude-plugin/plugin.json"; then
  ok "plugin.json does not declare hooks"
else
  no "plugin.json does not declare hooks" "hooks/hooks.json is auto-discovered; declaring it loads the plugin twice"
fi

if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) == {"modules": ["./register.tsx"]} else 1)' \
     "$PLUGIN/hooks/hooks.json"; then
  ok "hooks.json names only the hooks module"
else
  no "hooks.json names only the hooks module" "a command hook beside it would run twice"
fi

# VeroPlugins is the only marketplace: this repository publishes no catalog of its own.
[ ! -e "$ROOT/.claude-plugin/marketplace.json" ] && ok "no marketplace.json at the root" \
  || no "no marketplace.json at the root" "VeroPlugins is the only marketplace"

# The source check every Vero plugin carries, and its table (canonical copies in VeroPlugins/shared).
for f in hooks/source-check.ts tests/source-check.test.ts; do
  [ -f "$PLUGIN/$f" ] && ok "present: plugins/vero-dotto/$f" || no "present: plugins/vero-dotto/$f" "copy it from VeroPlugins/shared"
done

has "install.sh installs from VeroPlugins" "$(cat "$ROOT/install.sh")" 'REPO="GomelHawk/VeroPlugins"'
has "install.sh names the vero-plugins marketplace" "$(cat "$ROOT/install.sh")" 'MARKET="vero-plugins"'
# No other marketplace is named anywhere: every Vero plugin installs from VeroPlugins.
# (The names are spelled in pieces here so this file does not name them itself.)
other="$(printf 'verodotto-%s\|gomelhawk-%s' marketplace plugins)"
if grep -rqI -e "$other" --exclude-dir=.git "$ROOT"; then
  no "no other marketplace is named anywhere" "$(grep -rlI -e "$other" --exclude-dir=.git "$ROOT" | tr '\n' ' ')"
else
  ok "no other marketplace is named anywhere"
fi

for f in README.md LICENSE; do
  cmp -s <(tr -d '\r' < "$ROOT/$f") <(tr -d '\r' < "$PLUGIN/$f") && ok "$f is the same in the plugin" \
    || no "$f is the same in the plugin" "edit both, or copy one over the other"
done

[ ! -e "$PLUGIN/bin" ] && ok "no top-level bin/ in the plugin" \
  || no "no top-level bin/ in the plugin" "organization distribution rejects it"

echo
echo "== where =="

is "VERODOTTO_DIR wins" "$(bash "$VD" where)" "$WORK/cache"
is "else XDG_CACHE_HOME/verodotto" "$(env -u VERODOTTO_DIR XDG_CACHE_HOME="$WORK/xdg" bash "$VD" where)" "$WORK/xdg/verodotto"
is "else ~/.cache/verodotto" "$(env -u VERODOTTO_DIR -u XDG_CACHE_HOME HOME="$WORK/home" bash "$VD" where)" "$WORK/home/.cache/verodotto"

echo
echo "== a fake uv =="

# On PATH ahead of any real one. It logs what it was asked and the environment it saw,
# and writes canned markdown for a conversion.
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"
export FAKE_LOG="$WORK/uv.log"
cat > "$FAKEBIN/uv" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then echo "uv 0.12.24 (fake)"; exit 0; fi
printf 'call %s\n' "$*" >> "$FAKE_LOG"
printf 'env VIRTUAL_ENV=%s PYTHONPATH=%s UV_NO_CONFIG=%s UV_CACHE_DIR=%s BIN=%s REGISTRY=%s\n' \
  "${VIRTUAL_ENV:-}" "${PYTHONPATH:-}" "${UV_NO_CONFIG:-}" "${UV_CACHE_DIR:-}" \
  "${UV_PYTHON_INSTALL_BIN:-}" "${UV_PYTHON_INSTALL_REGISTRY:-}" >> "$FAKE_LOG"
for a in "$@"; do
  if [ "$a" = "--selftest" ]; then echo '{"python": "3.12.0", "mammoth": "fake"}'; exit 0; fi
  if [ "$a" = "--deps" ]; then exit 0; fi
done
# ... convert SRC OUT --max-sheet-cells N ...
while [ $# -gt 0 ] && [ "$1" != convert ]; do shift; done
src="$2"; out="$3"
mkdir -p "$out"
printf '# converted %s\n' "$(basename "$src")" > "$out/doc.md"
printf '{"source": "%s", "ext": ".docx", "size": 10, "mdChars": 20, "mdTokens": 5, "origTokens": 100, "isLowerBound": true, "lost": [], "converter": "fake", "kind": "full", "convertedAt": "now"}\n' "$(basename "$src")" > "$out/meta.json"
EOF
chmod +x "$FAKEBIN/uv"
export PATH="$FAKEBIN:$PATH"

echo
echo "== status and setup =="

is "no marker: missing" "$(bash "$VD" status | head -n 1)" "missing"
# A lock names the setup's process: alive, another session is setting up; gone (the
# session that ran it was closed), the lock is stale at once, whatever its age.
mkdir -p "$VERODOTTO_DIR/setup.lock"
sleep 30 & holder=$!
printf '%s\n' "$holder" > "$VERODOTTO_DIR/setup.lock/pid"
is "a lock whose process runs: preparing" "$(bash "$VD" status | head -n 1)" "preparing"
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
is "a lock whose process is gone: no setup" "$(bash "$VD" status | head -n 1)" "missing"
rm -f "$VERODOTTO_DIR/setup.lock/pid"
is "a lock with no pid, fresh: preparing" "$(bash "$VD" status | head -n 1)" "preparing"
touch -t 202001010000 "$VERODOTTO_DIR/setup.lock"
is "a lock with no pid, old: no setup" "$(bash "$VD" status | head -n 1)" "missing"

out="$(VIRTUAL_ENV=/somewhere/else PYTHONPATH=/x bash "$VD" setup 2>"$WORK/setup.err")"
is "setup takes a stale lock and finishes" "$out" "ready"
has "it reports its steps for the band" "$(cat "$WORK/setup.err")" "step: 1/3 using uv"
has "all three" "$(cat "$WORK/setup.err")" "step: 3/3 checking each converter"
[ ! -d "$VERODOTTO_DIR/setup.lock" ] && ok "setup releases its lock" || no "setup releases its lock"
has "the marker records the system uv" "$(cat "$VERODOTTO_DIR/ready")" '"uvSource":"system"'
has "the marker records the self-test's versions" "$(cat "$VERODOTTO_DIR/ready")" '"mammoth": "fake"'
is "marker present and matching: ready" "$(bash "$VD" status | head -n 1)" "ready"
hasnt "uv never sees an inherited VIRTUAL_ENV" "$(grep '^env' "$FAKE_LOG")" "VIRTUAL_ENV=/somewhere"
hasnt "nor an inherited PYTHONPATH" "$(grep '^env' "$FAKE_LOG")" "PYTHONPATH=/x"
has "and ignores the user's uv.toml" "$(grep '^env' "$FAKE_LOG" | tail -n 1)" "UV_NO_CONFIG=1"
has "with its own cache" "$(grep '^env' "$FAKE_LOG" | tail -n 1)" "UV_CACHE_DIR=$VERODOTTO_DIR/uv-cache"
has "its Python is never linked into ~/.local/bin" "$(grep '^env' "$FAKE_LOG" | tail -n 1)" "BIN=0"
has "nor registered with Windows" "$(grep '^env' "$FAKE_LOG" | tail -n 1)" "REGISTRY=0"

cp "$VERODOTTO_DIR/ready" "$WORK/ready.ok"
sed 's/"expect":"[^"]*"/"expect":"0000"/' "$WORK/ready.ok" > "$VERODOTTO_DIR/ready"
is "a marker from other converters: stale" "$(bash "$VD" status | head -n 1)" "stale"
cp "$WORK/ready.ok" "$VERODOTTO_DIR/ready"

echo
echo "== convert =="

DOCS="$WORK/docs"
mkdir -p "$DOCS"
printf 'docx bytes one' > "$DOCS/a.docx"
cp "$DOCS/a.docx" "$DOCS/copy of a.docx"
printf 'docx bytes two' > "$DOCS/b.docx"

first="$(bash "$VD" convert "$DOCS/a.docx" 2>/dev/null)"
dir_a="$(printf '%s' "$first" | head -n 1 | cut -f1)"
has "first conversion is new" "$(printf '%s' "$first" | head -n 1)" $'\tnew$'
has "it prints the meta" "$(printf '%s' "$first" | sed -n 2p)" '"mdTokens": 5'
is "the markdown is in the cache" "$(cat "$dir_a/doc.md")" "# converted a.docx"
second="$(bash "$VD" convert "$DOCS/copy of a.docx" 2>/dev/null | head -n 1)"
is "same bytes under another name: one entry" "$(printf '%s' "$second" | cut -f1)" "$dir_a"
has "served from the cache" "$second" $'\tcached$'
third="$(bash "$VD" convert "$DOCS/b.docx" 2>/dev/null | head -n 1 | cut -f1)"
[ "$third" != "$dir_a" ] && ok "other bytes: another entry" || no "other bytes: another entry"
sheet="$(bash "$VD" convert "$DOCS/a.docx" --max-sheet-cells 10 2>/dev/null | head -n 1 | cut -f1)"
[ "$sheet" != "$dir_a" ] && ok "other options: another entry" || no "other options: another entry"
is "conversions run with the converters offline" "$(grep -- ' convert ' "$FAKE_LOG" | grep -c -- '--offline')" "3"
calls="$(grep -c '^call' "$FAKE_LOG")"

# The memo: a second read of an unchanged file is not hashed again. A sha256sum that
# logs each file it hashes stands in front of the real one.
HASHBIN="$WORK/hashbin"
mkdir -p "$HASHBIN"
REAL_SHA="$(command -v sha256sum || true)"
if [ -n "$REAL_SHA" ]; then
  cat > "$HASHBIN/sha256sum" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in *.docx) echo "\$a" >> "$WORK/hashed.log" ;; esac; done
exec "$REAL_SHA" "\$@"
EOF
  chmod +x "$HASHBIN/sha256sum"
  : > "$WORK/hashed.log"
  PATH="$HASHBIN:$PATH" bash "$VD" convert "$DOCS/a.docx" >/dev/null 2>&1
  is "an unchanged file is not hashed again" "$(wc -l < "$WORK/hashed.log" | tr -d ' ')" "0"
  touch -t 202101010000 "$DOCS/a.docx"
  PATH="$HASHBIN:$PATH" bash "$VD" convert "$DOCS/a.docx" >/dev/null 2>&1
  is "a touched file is hashed again" "$(wc -l < "$WORK/hashed.log" | tr -d ' ')" "1"
else
  ok "memo check skipped: no sha256sum here (macOS uses shasum)"
fi
is "no conversion ran for cached files" "$(grep -c '^call' "$FAKE_LOG")" "$calls"

# shasum when sha256sum is absent (macOS): a PATH with every tool but sha256sum.
if command -v shasum >/dev/null 2>&1 && [ -n "$REAL_SHA" ]; then
  NOSHA="$WORK/nosha"
  mkdir -p "$NOSHA"
  IFS=: read -r -a dirs <<< "$PATH"
  for d in ${dirs[@]+"${dirs[@]}"}; do
    [ -d "$d" ] || continue
    for t in "$d"/*; do
      n="$(basename "$t")"
      [ "$n" = sha256sum ] && continue
      [ -e "$NOSHA/$n" ] || ln -s "$t" "$NOSHA/$n" 2>/dev/null
    done
  done
  out="$(PATH="$NOSHA" bash "$VD" convert "$DOCS/b.docx" 2>/dev/null | head -n 1 | cut -f1)"
  is "shasum gives the same key as sha256sum" "$out" "$third"
else
  ok "shasum check skipped: only one of sha256sum/shasum here"
fi

out="$(bash "$VD" convert "$DOCS/missing.docx" 2>&1)"; code=$?
is "a missing file fails with code 2" "$code" "2"

echo
echo "== save =="

out="$(bash "$VD" save "$dir_a" "$DOCS/a.docx.md")"
is "save writes the copy" "$out" "saved"
is "beside the original" "$(cat "$DOCS/a.docx.md")" "# converted a.docx"
is "an existing copy is not overwritten" "$(bash "$VD" save "$dir_a" "$DOCS/a.docx.md")" "exists"
is "unless forced" "$(bash "$VD" save "$dir_a" "$DOCS/a.docx.md" --force)" "saved"
has "a path that is no .md is refused" "$(bash "$VD" save "$dir_a" "$DOCS/a.txt")" "refused"
has "a folder that is no conversion is refused" "$(bash "$VD" save "$DOCS" "$DOCS/x.md")" "missing"

echo
echo "== sibling =="

is "a copy VeroDotto saved matches its original" "$(bash "$VD" sibling "$DOCS/a.docx")" "fresh"
touch -t 202201010000 "$DOCS/a.docx"
is "a touch is no change" "$(bash "$VD" sibling "$DOCS/a.docx")" "fresh"
printf 'docx bytes one, edited' > "$DOCS/a.docx"
is "an edit is" "$(bash "$VD" sibling "$DOCS/a.docx")" "stale"
dir_e="$(bash "$VD" convert "$DOCS/a.docx" 2>/dev/null | head -n 1 | cut -f1)"
bash "$VD" save "$dir_e" "$DOCS/a.docx.md" --force >/dev/null
is "saving again makes it fresh" "$(bash "$VD" sibling "$DOCS/a.docx")" "fresh"
printf '# by hand\n' > "$DOCS/b.docx.md"
is "a copy written by hand: unknown, dates decide" "$(bash "$VD" sibling "$DOCS/b.docx")" "unknown"
is "no copy at all: unknown" "$(bash "$VD" sibling "$DOCS/copy of a.docx")" "unknown"
rm -f "$DOCS/b.docx.md"
printf 'docx bytes one' > "$DOCS/a.docx"

echo
echo "== clean =="

mkdir -p "$VERODOTTO_DIR/bin" "$VERODOTTO_DIR/python"
printf 'x' > "$VERODOTTO_DIR/python/marker"
key_a="$(basename "$dir_a")"
now="$(date +%s)"
# a's conversion unused for 40 days, everything else used now
awk -F'\t' -v OFS='\t' -v k="$key_a" -v old=$((now - 40 * 86400)) '$1 == k { $2 = old } { print }' \
  "$VERODOTTO_DIR/index.tsv" > "$WORK/i" && mv "$WORK/i" "$VERODOTTO_DIR/index.tsv"
out="$(bash "$VD" clean --days 30 --max-mb 100)"
has "clean --days removes the stale conversion" "$out" "removed 1"
[ ! -d "$dir_a" ] && ok "it is gone" || no "it is gone"
[ -d "$(printf '%s' "$third")" ] && ok "a recent one stays" || no "a recent one stays"
[ -f "$VERODOTTO_DIR/python/marker" ] && ok "the toolchain is never touched" || no "the toolchain is never touched"

# --max-mb: a 2 MB conversion over a 1 MB cap goes, oldest first
big="$VERODOTTO_DIR/docs/bigone"
mkdir -p "$big"
dd if=/dev/zero of="$big/doc.md" bs=1024 count=2048 2>/dev/null
printf '{}' > "$big/meta.json"
printf 'bigone\t1\t1\t0\n' >> "$VERODOTTO_DIR/index.tsv"
bash "$VD" clean --max-mb 1 >/dev/null
[ ! -d "$big" ] && ok "clean --max-mb removes the least recently used past the cap" || no "clean --max-mb removes the least recently used past the cap"

out="$(bash "$VD" clean)"
has "clean with no options removes every conversion" "$out" "removed"
is "none left" "$(bash "$VD" sizes | grep count | cut -f2)" "0"
is "status is still ready: the converters stay" "$(bash "$VD" status | head -n 1)" "ready"

echo
echo "== purge =="

out="$(VERODOTTO_DIR="$WORK/notacache" bash "$VD" purge)"
has "nothing there: nothing to do" "$out" "nothing at"
mkdir -p "$WORK/precious"
printf 'keep me' > "$WORK/precious/file"
out="$(VERODOTTO_DIR="$WORK/precious" bash "$VD" purge)"; code=$?
has "a folder VeroDotto did not make is refused" "$out" "refused"
[ -f "$WORK/precious/file" ] && ok "and left alone" || no "and left alone"
out="$(VERODOTTO_DIR=/ bash "$VD" purge)"
has "the root is refused" "$out" "refused"
mkdir -p "$WORK/home/.cache"
out="$(VERODOTTO_DIR="$WORK/home" HOME="$WORK/home" bash "$VD" purge)"
has "the home folder is refused" "$out" "refused"
out="$(bash "$VD" purge)"
has "the cache itself is removed" "$out" "removed"
[ ! -e "$VERODOTTO_DIR" ] && ok "gone, converters and all" || no "gone, converters and all"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
