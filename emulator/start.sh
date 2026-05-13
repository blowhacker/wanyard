#!/usr/bin/env bash
set -e

DISPLAY_NUM=99
ADB_SERIAL=emulator-5554
ADB_TCP_PORT=5555
VNC_PORT=5900
NOVNC_PORT=6080
API=${ANDROID_API:-34}

export DISPLAY=":$DISPLAY_NUM"
export ANDROID_AVD_HOME=/avd

mkdir -p /avd

# Create AVD on first run (volume starts empty)
if [[ ! -f "/avd/eufy_avd.ini" ]]; then
  echo "[emulator] creating ARM64 AVD..."
  echo no | avdmanager create avd \
    --name eufy_avd \
    --package "system-images;android-${API};google_apis;arm64-v8a" \
    --device "pixel_6"
  echo "[emulator] AVD created"
fi

echo "[emulator] starting Xvfb"
Xvfb ":$DISPLAY_NUM" -screen 0 1080x2400x24 &
sleep 1

echo "[emulator] starting Android ARM64 emulator (software mode — first boot ~10-15 min)"
"$ANDROID_HOME/emulator/emulator" \
  -avd eufy_avd \
  -no-boot-anim \
  -noaudio \
  -no-snapshot \
  -accel off \
  -gpu swiftshader_indirect \
  -port 5554 \
  2>&1 | sed 's/^/[emu] /' &

EMU_PID=$!

echo "[emulator] waiting for ADB device..."
adb wait-for-device

echo "[emulator] waiting for boot_completed..."
until adb -s "$ADB_SERIAL" shell getprop sys.boot_completed 2>/dev/null | grep -q '^1'; do
  sleep 10
done
echo "[emulator] booted"

adb -s "$ADB_SERIAL" tcpip "$ADB_TCP_PORT"
echo "[emulator] ADB listening on TCP :$ADB_TCP_PORT"

echo "[emulator] starting x11vnc"
x11vnc -display ":$DISPLAY_NUM" -forever -nopw -rfbport "$VNC_PORT" -shared &

echo "[emulator] starting noVNC on :$NOVNC_PORT"
websockify --web /opt/novnc "$NOVNC_PORT" "localhost:$VNC_PORT" &

echo "[emulator] ready — noVNC :$NOVNC_PORT  ADB TCP :$ADB_TCP_PORT"
wait $EMU_PID
