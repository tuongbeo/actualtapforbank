#!/bin/bash
# Ensures the marketplaces/plugins declared in .claude/settings.json are actually
# synced into this container. Fresh cloud-session containers don't auto-clone
# marketplaces just because settings.json enables them, so without this hook,
# plugins like `superpowers` silently aren't available even though they show
# as "enabled" in config.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

SETTINGS_FILE="$CLAUDE_PROJECT_DIR/.claude/settings.json"
[ -f "$SETTINGS_FILE" ] || exit 0

INSTALLED_MARKETPLACES="$(claude plugin marketplace list --json 2>/dev/null || echo '[]')"
INSTALLED_PLUGINS="$(claude plugin list --json 2>/dev/null || echo '[]')"

# Add any marketplace referenced by settings.json that isn't already installed.
jq -r '.extraKnownMarketplaces // {} | keys[]' "$SETTINGS_FILE" | while read -r name; do
  if ! echo "$INSTALLED_MARKETPLACES" | jq -e --arg n "$name" 'any(.[]; .name == $n)' >/dev/null 2>&1; then
    source="$(jq -r --arg n "$name" '.extraKnownMarketplaces[$n].source' "$SETTINGS_FILE")"
    if [ "$(echo "$source" | jq -r '.source')" = "github" ]; then
      repo="$(echo "$source" | jq -r '.repo')"
      claude plugin marketplace add "$repo" 2>&1 || true
    elif [ "$(echo "$source" | jq -r '.source')" = "git" ]; then
      url="$(echo "$source" | jq -r '.url')"
      claude plugin marketplace add "$url" 2>&1 || true
    fi
  fi
done

# Install any plugin enabled in settings.json that isn't already installed.
jq -r '.enabledPlugins // {} | to_entries[] | select(.value == true) | .key' "$SETTINGS_FILE" | while read -r plugin; do
  if ! echo "$INSTALLED_PLUGINS" | jq -e --arg p "$plugin" 'any(.[]; .id == $p)' >/dev/null 2>&1; then
    claude plugin install "$plugin" 2>&1 || true
  fi
done
