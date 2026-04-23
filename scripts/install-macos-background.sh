#!/bin/bash
# 配車サーバーを Mac ログイン時からバックグラウンド常駐（launchd）に登録します。
set -e
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST_LABEL="com.dispatch-manager"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$PROJECT_DIR/logs"

if [ -z "$NODE_BIN" ]; then
  echo "エラー: node が見つかりません。PATH を確認してください。"
  exit 1
fi

mkdir -p "$LOG_DIR"

# 既に登録済みならいったん止める
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJECT_DIR}/server.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/server.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/server.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST_PATH"
echo ""
echo "登録しました: $PLIST_PATH"
echo "  ログ: $LOG_DIR/server.out.log / server.err.log"
echo ""
echo "今すぐ起動確認:"
launchctl list | grep "$PLIST_LABEL" || true
echo ""
echo "停止・削除は: bash $PROJECT_DIR/scripts/uninstall-macos-background.sh"
