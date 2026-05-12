#!/usr/bin/env bash
set -euo pipefail

apk_path="${1:-apk/eufy-security.apk}"
adb_target="${ADB_TARGET:-127.0.0.1:5555}"

if [[ ! -f "$apk_path" ]]; then
  echo "APK not found: $apk_path" >&2
  echo "Place the Eufy Security APK there or pass the APK path as the first argument." >&2
  exit 1
fi

adb connect "$adb_target"
adb -s "$adb_target" wait-for-device
adb -s "$adb_target" install -r "$apk_path"
