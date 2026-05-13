# Eufy Snapshot Current State

Last updated: 2026-05-13

## Goal

Build a Docker-ready snapshot service for the Eufy Battery Doorbell C31/C30 class device:

- capture timestamped JPEG snapshots on an interval
- store them under `snapshots/YYYY/MM/DD/`
- serve a LAN web viewer on port `8091`
- avoid storing Eufy credentials in git

## Repository State

The Python snapshot daemon and web viewer are implemented in `src/eufy_snapshot/`.

Implemented commands:

- `eufy-snapshot doctor`
- `eufy-snapshot capture-once`
- `eufy-snapshot run`
- `eufy-snapshot web`
- `eufy-snapshot serve`

Committed and pushed history currently includes:

- `3b62e48 Add Eufy snapshot daemon`
- `001df23 Add bundled emulator compose stack`
- `e8d1b40 Retry ADB connect during emulator startup`
- `c6beee4 Treat missing Eufy app as not ready`

Current local working tree still has uncommitted emulator-related edits:

- `.gitignore`
- `README.md`
- `docker-compose.yml`
- `scripts/install_eufy_apk.sh`
- `emulator/`
- `SETUP_NOTES.md`

## What Works

The web viewer works:

- `GET /api/health`
- `GET /api/images?date=YYYY-MM-DD`
- `GET /api/images/latest`
- `GET /images/<relative-path>`

The ADB/native-screenshot capture path worked against a host-managed Android Studio emulator on macOS:

- Android 14/API 34 emulator
- Eufy app manually installed and logged in
- camera live view manually opened
- `capture-once` created a valid JPEG at `snapshots/2026/05/12/2026-05-12_21-10-15.jpg`

## Docker/banana State

`banana` is an Ubuntu server with Docker and KVM available.

Clean test clone used:

```bash
/tmp/eufy-snapshot-clean
```

The Docker app and x86_64 Android emulator stack started there:

- web viewer: `http://banana:8091`
- noVNC emulator UI: `http://banana:6080`
- ADB/API 34 health checks passed before Eufy install

The original Compose stack may still be running on `banana`.

## Android Emulator Findings

The emulator path is not a good primary solution.

### x86_64 Android 14 Emulator

The Docker Android emulator runs, but the Eufy APKM is not usable there.

APK tested:

```text
com.oceanwing.battery.cam_v4.9.3_4379-4379_4arch_24lang_c0a729ff7192b4f5f17b3de72f5b844b_apkmirror.com.apkm
```

Attempt 1: install `base.apk + split_config.x86_64.apk + split_config.en.apk`

- install succeeded
- app crashed
- error: `UnsatisfiedLinkError: library "libhome_security.so" not found`
- Android selected `primaryCpuAbi=x86_64`

Attempt 2: install `base.apk + split_config.arm64_v8a.apk + split_config.en.apk`

- install succeeded
- Android selected `primaryCpuAbi=arm64-v8a`
- app crashed in native translation
- tombstone showed `SIGSEGV` in `/system/lib64/libndk_translation.so`

Conclusion: Eufy has native media/security pieces that do not survive x86_64 emulator translation.

### ARM64 Android Emulator on x86_64 Linux

Google's emulator refused to run an ARM64 Android 14 AVD on the x86_64 host, even with software acceleration:

```text
Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host.
System image must match the host architecture.
```

### Raw QEMU ARM64

`qemu-system-aarch64` was tried on `banana` using Android 14 ARM64 system image components.

What happened:

- kernel booted
- first-stage init reached early userspace
- metadata partition had to be created manually
- system rebooted to bootloader before a usable Android/ADB session

Conclusion: raw QEMU ARM64 is not practical for this project without recreating the Android emulator hardware and disk plumbing.

## Physical Android Fallback

A physical Android phone should still work because it avoids emulator ABI/translation issues.

Candidate noted earlier:

- Samsung Galaxy S5, unlocked
- LineageOS 17.1/18.1
- USB ADB connected to `banana`

Basic flow:

1. Enable USB debugging.
2. Disable lock screen and screen timeout.
3. Install the Eufy APK/APKM with `scripts/install_eufy_apk.sh`.
4. Log into Eufy manually.
5. Open the target camera live view.
6. Set `adb_serial` to the phone serial.
7. Run `eufy-snapshot serve`.

This remains a viable fallback, but it is operationally clunky.

## Better Direction: Use `bropat/eufy-security-client`

This was the next path to test, but the first real probe did not get image data.

Why it is better:

- avoids Android, APK splits, emulator ABI problems, and GUI automation
- can run directly in Docker on `banana`
- upstream says it connects to Eufy cloud, supports 2FA, and can connect to stations/devices using local or remote P2P
- upstream lists device livestream start/stop support
- upstream supported-devices docs list `Video Doorbell C31 (T8223; Battery Powered)` as supported

Useful upstream references:

- `https://github.com/bropat/eufy-security-client`
- `https://github.com/bropat/eufy-security-ws`
- `https://raw.githubusercontent.com/bropat/eufy-security-client/master/docs/supported_devices.md`

The previous note that `eufy-security-client` is incompatible with this device should be treated as stale. We did observe WebRTC behavior from the web portal, but the current bropat docs explicitly include C31/T8223 and recent changelog entries mention Battery Doorbell C30/C31 support. That makes the client worth testing before spending more time on Android.

## `eufy-security-client` Probe Result

Probe script:

```bash
scripts/probe_eufy_client.js
```

Local temp test directory:

```bash
/private/tmp/eufy-client-probe
```

Result on 2026-05-13:

- installed `eufy-security-client@3.8.0`
- first login required captcha
- after captcha, authentication succeeded
- client discovered the device:
  - name: `Front Door`
  - serial/station serial: `T82235102433535E`
  - model: `T8223`
  - type: `95`
  - library classified it as `isBatteryDoorbellC30: true`, not C31
- no cached picture was available:
  - `DevicePicture` missing
  - `DevicePictureUrl` empty
- livestream/P2P did not connect:
  - repeated `StationConnectTimeoutError: Timeout connecting to station`
  - no H264/video bytes received

Important IP finding:

- Eufy app reports doorbell IP: `192.168.1.13`
- `eufy-security-client` cloud metadata reports station IP/LAN IP: `192.168.1.38`
- `192.168.1.38` is this Mac, not the doorbell
- both addresses respond to ping, but ARP confirms different MAC addresses
- forcing `stationIPAddresses: { T82235102433535E: "192.168.1.13" }` still timed out
- retested while the official Eufy phone app had live video open; result was unchanged:
  - no cached picture
  - empty picture URL
  - P2P livestream timed out
- checked the Home Assistant video path from `https://www.youtube.com/watch?v=NY79GxJilO0`; useful detail was explicit station serial/IP configuration, which matches `stationIPAddresses`
- also tried `P2PConnectionType.ONLY_LOCAL` with `192.168.1.13`; livestream still timed out
- tried shared/guest Eufy account, matching the Home Assistant tutorial's separate-account approach:
  - authentication succeeded without captcha
  - same T8223 device discovered
  - no cached picture / empty picture URL
  - `ONLY_LOCAL` and `QUICKEST` livestream attempts still timed out
- tested the Home Assistant backend directly using `bropat/eufy-security-ws:latest` (`serverVersion 2.1.0`, `driverVersion 3.8.0`) on `banana` with host networking:
  - guest account
  - `STATION_IP_ADDRESSES=T82235102433535E:192.168.1.13`
  - `P2P_CONNECTION_SETUP=1` (`ONLY_LOCAL`)
  - websocket `device.get_properties` returned the doorbell and `picture: null`
  - websocket `device.start_livestream T82235102433535E` returned async success, then only emitted station `connection error`
  - server logs showed `localLookup` against `192.168.1.13`, then `All address lookup tentatives failed` and `Timeout connecting to station`
  - websocket `station.database_query_latest_info` also failed with station connection error

Current conclusion: the client can authenticate and discover the T8223 doorbell, but in this environment it did not provide a still image and could not establish the livestream/P2P path. Do not implement this backend until a probe can produce either a JPEG or usable video bytes.

## Proposed Pivot Architecture

Keep the existing Python web viewer and filesystem index. Replace the ADB capture backend with a bropat-based capture backend.

Recommended shape:

1. Add a Node helper package inside this repo, for example `node-capture/`.
2. Use `eufy-security-client` directly, or use `eufy-security-ws` as a sidecar container if its websocket API gives enough stream access.
3. Authenticate with Eufy credentials from environment variables or a local untracked config file.
4. Discover the target device by serial/name/type.
5. Start livestream or fetch the latest device picture through the client.
6. Convert a video frame to JPEG with `ffmpeg` if the API only provides livestream frames.
7. Write the JPEG into the existing timestamped `snapshots/` path.
8. Let the existing web UI continue to serve snapshots unchanged.

Possible Docker layout:

- `eufy-snapshot`: existing Python web/index service plus scheduler
- optional `eufy-security-ws`: `bropat/eufy-security-ws` sidecar
- shared `snapshots` volume
- credentials provided via `.env`, not committed

## Open Questions for the Pivot

- Does C31 expose a current still image through `eufy-security-client`, or do we need to start livestream and extract one frame?
- Does the C31 work over local P2P on the LAN, or only remote/cloud-assisted P2P?
- How does 2FA/captcha behave for a headless daemon, and what persistent auth state must be mounted?
- What exact device identifier should be used for selection: name, serial, or model/type?
- How battery-expensive is frequent livestream-start frame capture at 30-second intervals?

## Immediate Next Steps

1. Stop investing in bundled Android emulator as the main path.
2. Add a minimal bropat probe script that logs in and lists stations/devices.
3. Run that probe on `banana` with credentials from environment variables.
4. Confirm that the C31/T8223 appears and whether livestream or picture retrieval works.
5. If frame capture works, add a new `capture.method: eufy_client` backend and keep `eufy_native` only as legacy/fallback.
