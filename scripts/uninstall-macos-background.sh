#!/bin/bash
set -e
PLIST_LABEL="com.dispatch-manager"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "削除しました: $PLIST_PATH"
else
  echo "登録が見つかりません: $PLIST_PATH"
fi
