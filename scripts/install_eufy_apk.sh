#!/usr/bin/env bash
set -euo pipefail

apk_path="${1:-}"
adb_target="${ADB_TARGET:-127.0.0.1:5555}"
docker_container="${DOCKER_CONTAINER:-}"

# Default: try .apk then .apkm
if [[ -z "$apk_path" ]]; then
  if [[ -f "apk/eufy-security.apk" ]]; then
    apk_path="apk/eufy-security.apk"
  elif [[ -f "apk/eufy-security.apkm" ]]; then
    apk_path="apk/eufy-security.apkm"
  else
    echo "APK not found: apk/eufy-security.apk or apk/eufy-security.apkm" >&2
    echo "Place the Eufy Security APK/APKM there or pass the path as the first argument." >&2
    exit 1
  fi
fi

if [[ ! -f "$apk_path" ]]; then
  echo "APK not found: $apk_path" >&2
  exit 1
fi

# When no local adb, route commands through a Docker container that has it
_adb() {
  if [[ -n "$docker_container" ]]; then
    docker exec "$docker_container" adb "$@"
  else
    adb "$@"
  fi
}

_docker_cp() {
  local src="$1" dst="$2"
  if [[ -n "$docker_container" ]]; then
    docker cp "$src" "$docker_container:$dst"
  else
    cp "$src" "$dst"
  fi
}

# Auto-detect: if no local adb, find the app container
if ! command -v adb &>/dev/null && [[ -z "$docker_container" ]]; then
  if docker inspect eufy-snapshot &>/dev/null; then
    docker_container="eufy-snapshot"
    echo "No local adb found, routing through container: $docker_container"
  else
    echo "adb not found and no eufy-snapshot container running" >&2
    exit 1
  fi
fi

_adb connect "$adb_target"
_adb -s "$adb_target" wait-for-device

ext="${apk_path##*.}"

if [[ "$ext" == "apkm" ]]; then
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT

  echo "Extracting APKM bundle..."
  unzip -o "$apk_path" '*.apk' -d "$tmpdir" >/dev/null

  device_abi=$(_adb -s "$adb_target" shell getprop ro.product.cpu.abi | tr -d '\r')
  device_abilist=$(_adb -s "$adb_target" shell getprop ro.product.cpu.abilist | tr -d '\r')
  echo "Device ABI: $device_abi (supported: $device_abilist)"

  # Prefer arm64-v8a split when the device supports it (via translation on x86_64),
  # because Eufy ships arm64-only native libs — no x86_64 equivalents.
  if [[ "$device_abilist" == *"arm64-v8a"* && -f "$tmpdir/split_config.arm64_v8a.apk" ]]; then
    abi_split="split_config.arm64_v8a.apk"
  else
    case "$device_abi" in
      arm64-v8a)   abi_split="split_config.arm64_v8a.apk" ;;
      armeabi-v7a) abi_split="split_config.armeabi_v7a.apk" ;;
      x86_64)      abi_split="split_config.x86_64.apk" ;;
      x86)         abi_split="split_config.x86.apk" ;;
      *)           abi_split="" ;;
    esac
  fi

  local_splits=("$tmpdir/base.apk")
  if [[ -n "$abi_split" && -f "$tmpdir/$abi_split" ]]; then
    local_splits+=("$tmpdir/$abi_split")
    echo "Using ABI split: $abi_split"
  else
    echo "Warning: no matching ABI split for $device_abi, installing base only"
  fi

  if [[ -n "$docker_container" ]]; then
    # Copy splits into container then install
    container_splits=()
    for f in "${local_splits[@]}"; do
      dest="/tmp/$(basename "$f")"
      docker cp "$f" "$docker_container:$dest"
      container_splits+=("$dest")
    done
    docker exec "$docker_container" adb -s "$adb_target" install-multiple -r "${container_splits[@]}"
  else
    adb -s "$adb_target" install-multiple -r "${local_splits[@]}"
  fi
else
  if [[ -n "$docker_container" ]]; then
    docker cp "$apk_path" "$docker_container:/tmp/eufy-install.apk"
    docker exec "$docker_container" adb -s "$adb_target" install -r /tmp/eufy-install.apk
  else
    adb -s "$adb_target" install -r "$apk_path"
  fi
fi
