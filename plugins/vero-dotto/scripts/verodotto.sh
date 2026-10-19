#!/usr/bin/env bash
# VeroDotto's one shell entry point. The hooks module calls it through $.process.run;
# it is the only place that knows the cache layout.
#
#   verodotto.sh where                         the cache directory
#   verodotto.sh status                        ready | missing | stale | preparing, then ready's JSON
#   verodotto.sh setup                         uv, Python and the converters, once
#   verodotto.sh convert FILE [--max-sheet-cells N] [--max-sheet-rows N] [--max-tokens N] [--timeout S]
#                                              line 1: the conversion's folder TAB cached|new
#                                              then its meta.json
#   verodotto.sh save DOCDIR DEST [--force]    copy a conversion next to its original
#   verodotto.sh sibling ORIGINAL              fresh | stale | unknown: does ORIGINAL.md still match
#   verodotto.sh sizes                         docs, toolchain (KB) and the number of conversions
#   verodotto.sh clean [--days N] [--max-mb N] conversions: all, or the stale ones
#   verodotto.sh purge                         the whole cache directory
#
# Targets bash 3.2 (macOS): no mapfile, no fractional read -t, empty arrays expanded as
# ${a[@]+"${a[@]}"}, and no quote in a comment inside a multi-line $( ).
set -uo pipefail

# The pinned uv: release and the SHA-256 of each archive, values this script ships - never
# the .sha256 file next to the download.
UV_VERSION="0.12.24"
# A uv already on PATH is used when it is at least this.
UV_MIN="0.5.0"
PYTHON_VERSION="3.12"
LOCK_STALE_MIN=15

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONVERT="$HERE/convert.py"

cache_dir() { printf '%s\n' "${VERODOTTO_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/verodotto}"; }
DIR="$(cache_dir)"

# A path as Claude Code on Windows reads it: Git Bash says /c/Users/..., Read needs
# C:/Users/... . Elsewhere the path as it is.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

say() { printf '%s\n' "$*" >&2; }

is_windows() {
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac
}

uv_sha() {
  case "$1" in
    x86_64-unknown-linux-gnu)   echo b4dfaef47d491a7296981f8374a4595f55dbf84e8937c8ecd2983574d8bb3da6 ;;
    aarch64-unknown-linux-gnu)  echo 5231be65f496304623895dacdbf1de8504fec90303684bdf05805aa34414dd21 ;;
    x86_64-unknown-linux-musl)  echo 48170bd200a5430298c18f3b264485a1f3a8605f01088277daf6e37633edf0f5 ;;
    aarch64-unknown-linux-musl) echo 7f9ab4726d743b6a92e310477a7840c8a8a7b3938cb3c4657d541342fca75011 ;;
    x86_64-apple-darwin)        echo 4fa82e37cb94767661f532b001e470b67a186c7260e305bd84ddb78fd545c0b6 ;;
    aarch64-apple-darwin)       echo 0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732 ;;
    x86_64-pc-windows-msvc)     echo 7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019 ;;
    *) return 1 ;;
  esac
}

# --- hashing -------------------------------------------------------------------------

# sha256sum (Linux, Git Bash), else shasum (macOS).
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else return 1; fi
}
sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  else return 1; fi
}

# Size and modification time, GNU stat or BSD stat.
size_mtime() {
  stat -c '%s %Y' "$1" 2>/dev/null || stat -f '%z %m' "$1" 2>/dev/null
}

# The dependency header of convert.py: what setup installs. A change means a new setup.
deps_hash() {
  sha256_text "$(sed -n '/^# \/\/\/ script$/,/^# \/\/\/$/p' "$CONVERT" | tr -d '\r')" | cut -c1-16
}

# --- uv ------------------------------------------------------------------------------

uv_name() { if is_windows; then echo uv.exe; else echo uv; fi; }

# 1 when version $1 >= $2, compared field by field.
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, ".")
    for (i = 1; i <= (n > m ? n : m); i++) {
      p = x[i] + 0; q = y[i] + 0
      if (p > q) { print 1; exit } if (p < q) { print 0; exit }
    }
    print 1 }'
}

uv_version_of() { "$1" --version 2>/dev/null | awk '{ print $2; exit }'; }

# The uv to run: ours in $DIR/bin, else one on PATH that is new enough. Prints nothing
# when there is none.
find_uv() {
  local own system ver
  own="$DIR/bin/$(uv_name)"
  if [ -x "$own" ]; then echo "$own"; return 0; fi
  system="$(command -v uv 2>/dev/null || true)"
  [ -n "$system" ] || return 0
  ver="$(uv_version_of "$system")"
  [ -n "$ver" ] && [ "$(version_ge "$ver" "$UV_MIN")" = 1 ] && echo "$system"
  return 0
}

# Every uv call goes through here, so the private cache and Python, and the cleared
# environment, are never forgotten: a VIRTUAL_ENV, PYTHONPATH or PYTHONHOME set by
# whoever started Claude Code would point uv at someone else's interpreter, and a user's
# uv.toml at someone else's index. Its Python is never linked into ~/.local/bin nor
# registered with Windows (UV_PYTHON_INSTALL_BIN, UV_PYTHON_INSTALL_REGISTRY): nothing
# outside the cache directory changes.
run_uv() {
  local uv="$1"; shift
  env -u VIRTUAL_ENV -u PYTHONPATH -u PYTHONHOME -u UV_SYSTEM_PYTHON -u UV_PYTHON \
    UV_CACHE_DIR="$DIR/uv-cache" \
    UV_PYTHON_INSTALL_DIR="$DIR/python" \
    UV_PYTHON_INSTALL_BIN=0 \
    UV_PYTHON_INSTALL_REGISTRY=0 \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_NO_CONFIG=1 \
    UV_NO_PROGRESS=1 \
    "$uv" "$@"
}

uv_target() {
  local os arch libc
  os="$(uname -s 2>/dev/null)"; arch="$(uname -m 2>/dev/null)"
  case "$arch" in
    x86_64|amd64) arch=x86_64 ;;
    arm64|aarch64) arch=aarch64 ;;
    *) return 1 ;;
  esac
  case "$os" in
    Linux)
      libc=gnu
      if ldd --version 2>&1 | grep -qi musl; then libc=musl; fi
      echo "$arch-unknown-linux-$libc" ;;
    Darwin) echo "$arch-apple-darwin" ;;
    # Windows on ARM runs the x64 build under emulation; uv ships no other.
    MINGW*|MSYS*|CYGWIN*) echo "x86_64-pc-windows-msvc" ;;
    *) return 1 ;;
  esac
}

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else say "neither curl nor wget is installed"; return 1; fi
}

download_uv() {
  local target want url archive got tmp found
  target="$(uv_target)" || { say "no uv build for $(uname -s) $(uname -m)"; return 1; }
  want="$(uv_sha "$target")" || { say "no pinned checksum for $target"; return 1; }
  tmp="$DIR/.uv-download.$$"
  rm -rf "$tmp"; mkdir -p "$tmp" "$DIR/bin"
  case "$target" in
    *windows*) archive="uv-$target.zip" ;;
    *) archive="uv-$target.tar.gz" ;;
  esac
  url="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$archive"
  fetch "$url" "$tmp/$archive" || { rm -rf "$tmp"; say "could not download $url"; return 1; }
  got="$(sha256_file "$tmp/$archive")"
  if [ "$got" != "$want" ]; then
    rm -rf "$tmp"; say "uv download checksum mismatch: got $got, expected $want"; return 1
  fi
  case "$archive" in
    *.zip)
      if command -v unzip >/dev/null 2>&1; then unzip -q "$tmp/$archive" -d "$tmp/x"
      else powershell -NoProfile -Command "Expand-Archive -Path '$tmp/$archive' -DestinationPath '$tmp/x'"
      fi ;;
    *) mkdir -p "$tmp/x" && tar -xzf "$tmp/$archive" -C "$tmp/x" ;;
  esac
  found="$(find "$tmp/x" -type f -name "$(uv_name)" | head -n 1)"
  [ -n "$found" ] || { rm -rf "$tmp"; say "uv archive holds no $(uv_name)"; return 1; }
  mv -f "$found" "$DIR/bin/$(uv_name)" && chmod +x "$DIR/bin/$(uv_name)"
  rm -rf "$tmp"
}

# --- status and setup ----------------------------------------------------------------

json_field() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n 1 | sed 's/^[^:]*:"//; s/"$//'; }

# A setup in progress: the lock exists and the process that took it still runs. A session
# closed mid-setup takes its setup with it, and the next session starts again at once
# instead of waiting; without a pid (a lock from a crash between mkdir and the write)
# the lock counts until it is LOCK_STALE_MIN old.
lock_is_fresh() {
  local pid
  [ -d "$DIR/setup.lock" ] || return 1
  if [ -f "$DIR/setup.lock/pid" ]; then
    pid="$(head -n 1 "$DIR/setup.lock/pid" 2>/dev/null)"
    case "$pid" in ""|*[!0-9]*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null
    return
  fi
  [ -z "$(find "$DIR/setup.lock" -maxdepth 0 -mmin +"$LOCK_STALE_MIN" 2>/dev/null)" ]
}

# ready: the marker matches this plugin's converters and its uv is still there.
cmd_status() {
  local ready uv src
  if [ ! -f "$DIR/ready" ]; then
    if lock_is_fresh; then echo preparing; else echo missing; fi
    return 0
  fi
  ready="$(tr -d '\r\n' < "$DIR/ready")"
  uv="$(find_uv)"
  src="$(json_field "$ready" uvSource)"
  if [ "$(json_field "$ready" expect)" != "$(deps_hash)" ] || [ -z "$uv" ] \
     || { [ "$src" = bundled ] && [ "$(json_field "$ready" uv)" != "$UV_VERSION" ]; } \
     || { [ "$src" = bundled ] && [ ! -x "$DIR/bin/$(uv_name)" ]; }; then
    if lock_is_fresh; then echo preparing; else echo stale; fi
  else
    echo ready
  fi
  printf '%s\n' "$ready"
}

release_lock() { rm -rf "$DIR/setup.lock"; }

fail() { echo "failed: $*"; exit 1; }

cmd_setup() {
  local uv src selftest waited=0
  mkdir -p "$DIR" || fail "cannot create $DIR"
  # One setup at a time: mkdir is atomic. A lock older than LOCK_STALE_MIN is a setup
  # that died; a fresh one is another session's, so wait for its marker.
  if ! mkdir "$DIR/setup.lock" 2>/dev/null; then
    if lock_is_fresh; then
      say "step: another Claude Code session is setting up; waiting for it"
      while lock_is_fresh && [ "$waited" -lt 600 ]; do sleep 2; waited=$((waited + 2)); done
      if [ "$(cmd_status | head -n 1)" = ready ]; then echo ready; return 0; fi
    fi
    rm -rf "$DIR/setup.lock"
    mkdir "$DIR/setup.lock" 2>/dev/null || fail "cannot take the setup lock in $DIR"
  fi
  printf '%s\n' "$$" > "$DIR/setup.lock/pid"
  # Closed mid-setup (the session ended, the plugin unloaded): the lock goes with it. What
  # uv finished downloading stays in its cache, so the next setup resumes from there.
  trap release_lock EXIT
  trap 'exit 130' INT TERM HUP

  uv="$(find_uv)"
  src=system
  case "$uv" in "$DIR/bin/"*) src=bundled ;; esac
  # Our own uv must be the pinned one; a system uv is used as it is.
  if [ "$src" = bundled ] && [ "$(uv_version_of "$uv")" != "$UV_VERSION" ]; then uv=""; fi
  # Progress for the person: each "step:" line on stderr is what the plugin shows above
  # the prompt while setup runs.
  if [ -z "$uv" ]; then
    say "step: 1/3 downloading uv $UV_VERSION (~40 MB)"
    download_uv || fail "could not download uv - check the network or a proxy (HTTPS_PROXY)"
    uv="$DIR/bin/$(uv_name)"; src=bundled
  else
    say "step: 1/3 using uv $(uv_version_of "$uv") from PATH"
  fi

  say "step: 2/3 installing Python $PYTHON_VERSION and the converters (~200 MB)"
  run_uv "$uv" run --quiet --python "$PYTHON_VERSION" --script "$CONVERT" --deps >&2 \
    || fail "could not install Python or the converters - check the network or a proxy (HTTPS_PROXY)"
  say "step: 3/3 checking each converter"
  selftest="$(run_uv "$uv" run --quiet --offline --python "$PYTHON_VERSION" --script "$CONVERT" --selftest)" \
    || fail "a converter failed its self-test"
  selftest="$(printf '%s' "$selftest" | tr -d '\r\n')"
  [ -n "$selftest" ] || selftest='{}'

  printf '{"expect":"%s","uv":"%s","uvSource":"%s","os":"%s","date":"%s","converters":%s}\n' \
    "$(deps_hash)" "$(uv_version_of "$uv")" "$src" "$(uname -s)-$(uname -m)" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$selftest" > "$DIR/ready.$$" \
    && mv -f "$DIR/ready.$$" "$DIR/ready" || fail "cannot write $DIR/ready"
  echo ready
}

# --- convert -------------------------------------------------------------------------

memo_lookup() {
  [ -f "$DIR/memo.tsv" ] || return 0
  awk -F'\t' -v p="$1" -v s="$2" -v m="$3" '$4 == p && $2 == s && $3 == m { k = $1 } END { if (k != "") print k }' "$DIR/memo.tsv"
}

# index.tsv: key, last used (epoch), reads, est. tokens saved. Written by the plugin, never
# taken from atime, which noatime/relatime mounts do not keep.
index_bump() {
  local key="$1" saved="$2" now tmp
  now="$(date +%s)"; tmp="$DIR/index.tsv.$$"
  touch "$DIR/index.tsv"
  awk -F'\t' -v OFS='\t' -v k="$key" -v t="$now" -v s="$saved" '
    $1 == k { $2 = t; $3 = $3 + 1; $4 = $4 + s; found = 1 }
    { print }
    END { if (!found) print k, t, 1, s }' "$DIR/index.tsv" > "$tmp" && mv -f "$tmp" "$DIR/index.tsv"
}

# A file as this script names it: a POSIX path (Git Bash's on Windows), made absolute.
posix_abs() {
  local path="$1"
  if command -v cygpath >/dev/null 2>&1; then path="$(cygpath -u "$path")"; fi
  case "$path" in /*) printf '%s\n' "$path" ;; *) printf '%s\n' "$PWD/$path" ;; esac
}

# A file's SHA-256, hashed only after a cheap stat against the memo: re-reading a 50 MB
# PDF is a lookup. $1 must be absolute (posix_abs).
file_sha() {
  local abs="$1" sm size mtime sha
  sm="$(size_mtime "$abs")" || return 1
  size="${sm%% *}"; mtime="${sm##* }"
  sha="$(memo_lookup "$abs" "$size" "$mtime")"
  if [ -z "$sha" ]; then
    sha="$(sha256_file "$abs")" || return 1
    mkdir -p "$DIR"
    printf '%s\t%s\t%s\t%s\n' "$sha" "$size" "$mtime" "$abs" >> "$DIR/memo.tsv"
  fi
  printf '%s\n' "$sha"
}

cmd_convert() {
  local src="${1:-}" cells=5000 rows=20 tokens=50000 timeout=100 uv sha key doc tmp abs status meta orig md
  [ -n "$src" ] || { say "usage: convert FILE"; exit 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --max-sheet-cells) cells="$2"; shift ;;
      --max-sheet-rows) rows="$2"; shift ;;
      --max-tokens) tokens="$2"; shift ;;
      --timeout) timeout="$2"; shift ;;
      *) say "unknown option: $1"; exit 2 ;;
    esac
    shift
  done
  abs="$(posix_abs "$src")"; src="$abs"
  [ -f "$src" ] || { say "no such file: $src"; exit 2; }
  [ "$(cmd_status | head -n 1)" = ready ] || { say "converters not ready"; exit 3; }
  uv="$(find_uv)"
  sha="$(file_sha "$abs")" || { say "no sha256sum or shasum"; exit 4; }
  # The key: the bytes, the converter's own code and the options that shape its output.
  key="$(sha256_text "$sha|$(sha256_file "$CONVERT" | cut -c1-16)|$cells|$rows|$tokens")"
  doc="$DIR/docs/$key"
  status=cached
  if [ ! -f "$doc/meta.json" ]; then
    status=new
    tmp="$DIR/docs/.tmp-$$-${key:0:12}"
    rm -rf "$tmp"; mkdir -p "$tmp"
    if ! run_uv "$uv" run --quiet --offline --python "$PYTHON_VERSION" --script "$CONVERT" convert "$src" "$tmp" \
         --max-sheet-cells "$cells" --max-sheet-rows "$rows" --max-tokens "$tokens" --timeout "$timeout" >&2; then
      rm -rf "$tmp"; say "conversion failed: $src"; exit 5
    fi
    if [ -f "$doc/meta.json" ]; then rm -rf "$tmp"; else rm -rf "$doc"; mv -f "$tmp" "$doc"; fi
  fi
  meta="$(tr -d '\r\n' < "$doc/meta.json")"
  orig="$(printf '%s' "$meta" | grep -o '"origTokens": *[0-9]*' | grep -o '[0-9]*$')"
  md="$(printf '%s' "$meta" | grep -o '"mdTokens": *[0-9]*' | grep -o '[0-9]*$')"
  index_bump "$key" "$(( ${orig:-0} > ${md:-0} ? ${orig:-0} - ${md:-0} : 0 ))"
  printf '%s\t%s\n%s\n' "$(native_path "$doc")" "$status" "$meta"
}

# --- save, sizes, clean, purge -------------------------------------------------------

cmd_save() {
  local doc="${1:-}" dest="${2:-}" force="${3:-}"
  if command -v cygpath >/dev/null 2>&1; then doc="$(cygpath -u "$doc")"; dest="$(cygpath -u "$dest")"; fi
  [ -f "$doc/doc.md" ] || { echo "missing"; exit 1; }
  case "$doc" in "$DIR/docs/"*) ;; *) echo "refused: not a conversion"; exit 1 ;; esac
  case "$dest" in *.md) ;; *) echo "refused: not a .md path"; exit 1 ;; esac
  [ -d "$(dirname "$dest")" ] || { echo "refused: no such folder"; exit 1; }
  if [ -e "$dest" ] && [ "$force" != --force ]; then echo exists; return 0; fi
  cp -f "$doc/doc.md" "$dest" || { echo "failed"; exit 1; }
  record_save "$dest"
  echo saved
}

# saves.tsv: a copy VeroDotto saved, and the checksum of its original at that moment, so
# "the original changed" means its content changed - not a touch or a save without edits.
record_save() {
  local dest orig sha tmp="$DIR/saves.tsv.$$"
  dest="$(posix_abs "$1")"; orig="${dest%.md}"
  [ -f "$orig" ] || return 0
  sha="$(file_sha "$orig")" || return 0
  touch "$DIR/saves.tsv"
  awk -F'\t' -v d="$dest" '$1 != d' "$DIR/saves.tsv" > "$tmp" && printf '%s\t%s\n' "$dest" "$sha" >> "$tmp" \
    && mv -f "$tmp" "$DIR/saves.tsv"
}

# Whether the copy beside ORIGINAL (ORIGINAL.md) still matches it: fresh, stale, or
# unknown for a copy VeroDotto never saved (the plugin then compares file dates).
cmd_sibling() {
  local orig dest saved now
  orig="$(posix_abs "${1:-}")"; dest="$orig.md"
  [ -f "$orig" ] && [ -f "$dest" ] || { echo unknown; return 0; }
  saved="$( [ -f "$DIR/saves.tsv" ] && awk -F'\t' -v d="$dest" '$1 == d { s = $2 } END { print s }' "$DIR/saves.tsv")"
  [ -n "$saved" ] || { echo unknown; return 0; }
  now="$(file_sha "$orig")" || { echo unknown; return 0; }
  if [ "$now" = "$saved" ]; then echo fresh; else echo stale; fi
}

kb_of() { if [ -e "$1" ]; then du -sk "$1" 2>/dev/null | awk '{ print $1 }'; else echo 0; fi; }

cmd_sizes() {
  local n=0 d tool
  for d in "$DIR"/docs/*/; do [ -f "${d}meta.json" ] && n=$((n + 1)); done
  tool=$(( $(kb_of "$DIR/bin") + $(kb_of "$DIR/python") + $(kb_of "$DIR/uv-cache") ))
  printf 'docs\t%s\ntoolchain\t%s\ncount\t%s\n' "$(kb_of "$DIR/docs")" "$tool" "$n"
}

remove_doc() {
  case "$1" in ""|*/*|.*) return 0 ;; esac
  rm -rf "${DIR:?}/docs/$1"
}

# Drop index rows whose conversion is gone, and the memo (it is only a shortcut).
tidy_index() {
  local tmp="$DIR/index.tsv.$$"
  [ -f "$DIR/index.tsv" ] || return 0
  while IFS="$(printf '\t')" read -r key rest; do
    [ -d "$DIR/docs/$key" ] && printf '%s\t%s\n' "$key" "$rest"
  done < "$DIR/index.tsv" > "$tmp"
  mv -f "$tmp" "$DIR/index.tsv"
}

# No options: every conversion, now. --days/--max-mb: those unused for DAYS, then the
# least recently used until the conversions fit in MB. The toolchain is never touched.
cmd_clean() {
  local days="" maxmb="" now cutoff removed=0 key last d name kept
  while [ $# -gt 0 ]; do
    case "$1" in
      --days) days="$2"; shift ;;
      --max-mb) maxmb="$2"; shift ;;
      *) say "unknown option: $1"; exit 2 ;;
    esac
    shift
  done
  [ -d "$DIR/docs" ] || { echo "removed 0"; return 0; }
  if [ -z "$days" ] && [ -z "$maxmb" ]; then
    for d in "$DIR"/docs/*/ "$DIR"/docs/.tmp-*/; do
      [ -d "$d" ] || continue
      rm -rf "$d"; removed=$((removed + 1))
    done
    rm -f "$DIR/index.tsv" "$DIR/memo.tsv"
    echo "removed $removed"
    return 0
  fi
  now="$(date +%s)"
  touch "$DIR/index.tsv"
  # A conversion the index does not know (an interrupted run) counts as used now.
  for d in "$DIR"/docs/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    awk -F'\t' -v k="$name" '$1 == k { f = 1 } END { exit !f }' "$DIR/index.tsv" \
      || printf '%s\t%s\t0\t0\n' "$name" "$now" >> "$DIR/index.tsv"
  done
  # Leftovers of a conversion that died midway.
  find "$DIR/docs" -maxdepth 1 -name '.tmp-*' -mmin +60 -exec rm -rf {} + 2>/dev/null
  if [ -n "$days" ]; then
    cutoff=$((now - days * 86400))
    while IFS="$(printf '\t')" read -r key last _; do
      if [ "${last:-0}" -lt "$cutoff" ] && [ -d "$DIR/docs/$key" ]; then
        remove_doc "$key"; removed=$((removed + 1))
      fi
    done < "$DIR/index.tsv"
    tidy_index
  fi
  if [ -n "$maxmb" ]; then
    for key in $(sort -t "$(printf '\t')" -k2,2n "$DIR/index.tsv" | cut -f1); do
      [ "$(kb_of "$DIR/docs")" -gt $((maxmb * 1024)) ] || break
      if [ -d "$DIR/docs/$key" ]; then remove_doc "$key"; removed=$((removed + 1)); fi
    done
    tidy_index
  fi
  rm -f "$DIR/memo.tsv"
  kept=0
  for d in "$DIR"/docs/*/; do [ -d "$d" ] && kept=$((kept + 1)); done
  echo "removed $removed, kept $kept"
}

# Only a directory VeroDotto made: named verodotto, or holding its marker or conversions.
# Never rm -rf a path just because a variable said so.
is_cache_dir() {
  case "$1" in /*|[A-Za-z]:*) ;; *) return 1 ;; esac
  case "$1" in /|"$HOME"|"$HOME/") return 1 ;; esac
  [ "$(basename "$1")" = verodotto ] && return 0
  [ -f "$1/ready" ] || [ -d "$1/docs" ]
}

cmd_purge() {
  if [ ! -e "$DIR" ]; then echo "nothing at $DIR"; return 0; fi
  is_cache_dir "$DIR" || { echo "refused: $DIR is not a VeroDotto cache"; exit 1; }
  rm -rf "$DIR" || { echo "failed: could not delete $DIR"; exit 1; }
  echo "removed $DIR"
}

case "${1:-}" in
  where) native_path "$DIR" ;;
  status) cmd_status ;;
  setup) cmd_setup ;;
  convert) shift; cmd_convert "$@" ;;
  save) shift; cmd_save "$@" ;;
  sibling) shift; cmd_sibling "$@" ;;
  sizes) cmd_sizes ;;
  clean) shift; cmd_clean "$@" ;;
  purge) cmd_purge ;;
  *) say "usage: verodotto.sh where|status|setup|convert|save|sizes|clean|purge"; exit 2 ;;
esac
