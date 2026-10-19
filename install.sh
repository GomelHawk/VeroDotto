#!/usr/bin/env bash
# Install the vero-dotto plugin from VeroPlugins, the marketplace every Vero plugin is
# installed from. This clone is only validated first; to run the code in this clone
# instead, use `claude --plugin-dir plugins/vero-dotto`.
#   ./install.sh                        install for your user
#   ./install.sh --scope project DIR    share it with everyone who works in DIR
#   ./install.sh --scope local DIR      install it for yourself, in DIR only
#
# Project and local scope write to DIR's .claude/ settings, so they need DIR: run from
# this clone, the current directory would be the clone itself.
set -euo pipefail

REPO="GomelHawk/VeroPlugins"
MARKET="vero-plugins"
PLUGIN="vero-dotto"
SCOPE="user"
DIR=""
case "${1:-}" in
  "") ;;
  --scope) SCOPE="${2:-}"; DIR="${3:-}" ;;
  *) echo "Unknown option: $1 (see the top of this script)"; exit 1 ;;
esac

command -v claude >/dev/null 2>&1 || { echo "claude CLI not found on PATH"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$SCOPE" in
  user) ;;
  project|local)
    [ -n "$DIR" ] || { echo "--scope $SCOPE needs the project's directory: ./install.sh --scope $SCOPE DIR"; exit 1; }
    DIR="$(cd "$DIR" 2>/dev/null && pwd)" || { echo "No such directory: ${3:-}"; exit 1; }
    [ "$DIR" != "$HERE" ] || { echo "DIR is this clone; name the project to install VeroDotto into"; exit 1; }
    ;;
  *) echo "Unknown scope: $SCOPE (user, project or local)"; exit 1 ;;
esac

echo "Validating the plugin..."
claude plugin validate "$HERE/plugins/$PLUGIN"

echo
echo "Registering the VeroPlugins marketplace..."
case "$SCOPE" in
  user) claude plugin marketplace add "$REPO" ;;
  *)    (cd "$DIR" && claude plugin marketplace add "$REPO" --scope "$SCOPE") ;;
esac

echo
echo "VeroDotto hands Claude your documents as clean markdown."
echo "Its first session downloads uv, Python and the converters (~240 MB, once) into"
echo "${VERODOTTO_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/verodotto} - turn that off in /config -> autoSetup."
echo
if [ "$SCOPE" = "user" ]; then
  claude plugin install "$PLUGIN@$MARKET"
else
  (cd "$DIR" && claude plugin install "$PLUGIN@$MARKET" --scope "$SCOPE")
  echo
  if [ "$SCOPE" = "project" ]; then
    echo "Written to $DIR/.claude/settings.json - commit it to share VeroDotto with the team."
  else
    echo "Written to $DIR/.claude/settings.local.json - for you only, never committed."
  fi
fi

echo
echo "Installed. Restart Claude Code, then:"
echo "  @docs/spec.docx ...      a mention is read as markdown, the saving shown above the prompt"
echo "  /vero-dotto              status: converters, cache, formats"
echo "  /vero-dotto stats        tokens saved, this session and all time"
