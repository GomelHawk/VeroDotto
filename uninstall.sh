#!/usr/bin/env bash
# Remove the vero-dotto plugin and, optionally, its cache.
#   ./uninstall.sh                        remove the plugin, keep the cache
#   ./uninstall.sh --scope project DIR    remove it from DIR's shared settings
#   ./uninstall.sh --scope local DIR      remove it from DIR's local settings
#   ./uninstall.sh --purge                also delete ~/.cache/verodotto: every
#                                         conversion and the converters
# --purge combines with --scope; -y skips its question.
set -euo pipefail

SCOPE="user"
DIR=""
PURGE=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    -y|--yes) YES=1 ;;
    --scope) SCOPE="${2:-}"; DIR="${3:-}"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

command -v claude >/dev/null 2>&1 || { echo "claude CLI not found on PATH"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$(bash "$HERE/plugins/vero-dotto/scripts/verodotto.sh" where)"

case "$SCOPE" in
  user) DIR="$PWD" ;;
  project|local)
    [ -n "$DIR" ] || { echo "--scope $SCOPE needs the project's directory: ./uninstall.sh --scope $SCOPE DIR"; exit 1; }
    DIR="$(cd "$DIR" 2>/dev/null && pwd)" || { echo "No such directory: $DIR"; exit 1; }
    ;;
  *) echo "Unknown scope: $SCOPE (user, project or local)"; exit 1 ;;
esac

# A step that finds nothing to remove is not fatal - the plugin may never have been
# installed at this scope - but it says so rather than passing in silence.
echo "Uninstalling the plugin at $SCOPE scope (this removes its hooks module and command)..."
(cd "$DIR" && claude plugin uninstall "vero-dotto@vero-plugins" --scope "$SCOPE") \
  || echo "  (not removed: see the message above)"

# The VeroPlugins marketplace stays registered: other Vero plugins install from it.
echo "The VeroPlugins marketplace is left registered (other Vero plugins use it)."
echo "To remove it too: claude plugin marketplace remove vero-plugins"

echo
if [ "$PURGE" = 1 ]; then
  if [ ! -e "$CACHE" ]; then
    echo "No cache at $CACHE"
  else
    echo "The cache holds the text of every document VeroDotto converted, and its converters:"
    printf '  %s  %s\n' "$(du -sh "$CACHE" 2>/dev/null | cut -f1)" "$CACHE"
    if [ "$YES" != 1 ] && [ -t 0 ]; then
      printf 'Delete it? [y/N] '
      read -r answer
      case "$answer" in y|Y|yes|YES) ;; *) echo "Kept."; PURGE=0 ;; esac
    fi
    # verodotto.sh purge deletes only a folder VeroDotto made, whatever VERODOTTO_DIR says.
    [ "$PURGE" = 1 ] && bash "$HERE/plugins/vero-dotto/scripts/verodotto.sh" purge
  fi
else
  echo "The cache was left in place at: $CACHE"
  echo "It holds the text of every converted document. Delete it with: ./uninstall.sh --purge"
fi

echo
echo "Done. VeroDotto never wrote inside your projects, except copies you saved yourself."
