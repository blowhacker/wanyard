# Eufy Snapshot

Capture camera-only screenshots from the Eufy Android app through ADB and serve a LAN web viewer for recent snapshots.

## Assumptions

- Eufy is installed, logged in, permissions are granted, and the target camera live view is open.
- Capture uses the in-app Screenshot/scissors button, configured as tap coordinates in `config.yaml`.
- The Eufy APK and credentials are not bundled. You must install/login once in the emulator UI.

## Commands

```bash
python -m pip install -e .
eufy-snapshot doctor
eufy-snapshot capture-once
eufy-snapshot capture-once --source rtsp_front_door
eufy-snapshot run
eufy-snapshot web
eufy-snapshot serve
```

`serve` runs both the capture worker and the web viewer.

## Sources

`config.yaml` supports multiple named sources. Each source has its own capture method and interval, and the web viewer can filter snapshots by source.

The current local RTSP source is configured as:

```yaml
sources:
  rtsp_front_door:
    name: Front Door RTSP
    type: rtsp
    enabled: true
    interval_seconds: 30
    output_subdir: rtsp_front_door
    url_env: FRONT_DOOR_RTSP_URL
    rtsp_transport: tcp
    timeout_seconds: 20
```

Put the credentialed RTSP URL in `.env` or the runtime environment:

```bash
FRONT_DOOR_RTSP_URL=rtsp://user:password@camera-ip:554/stream1
```

RTSP capture requires `ffmpeg`.

## Docker

The image includes Python app code, Android platform tools, and `ffmpeg`. The emulator remains on the host for `eufy_native` sources.

```bash
docker build -t eufy-snapshot .
docker run --rm \
  -p 8091:8091 \
  -e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037 \
  -v "$PWD/config.yaml:/app/config.yaml" \
  -v "$PWD/snapshots:/app/snapshots" \
  eufy-snapshot serve
```

If Docker cannot resolve `host.docker.internal` on Linux, add `--add-host=host.docker.internal:host-gateway` or run with host networking where available. The host ADB server must be reachable from the container.

## Bundled Emulator

`docker-compose.yml` runs an Android 14/API 34 ARM64 emulator container plus the snapshot app container.

```bash
docker compose up --build
```

The first `docker compose build` downloads a ~2 GB ARM64 system image. The emulator's first boot takes 10–15 minutes (software ARM64 emulation, no KVM required). Subsequent starts are faster.

Open:

- Web viewer: `http://localhost:8091`
- Emulator noVNC: `http://localhost:6080`

The Compose stack uses `config.compose.yaml`, where ADB points at the emulator service:

```yaml
adb_serial: eufy-emulator:5555
adb_connect: eufy-emulator:5555
```

After the emulator boots, install Eufy and log in through noVNC. To sideload a user-supplied APK or APKM bundle:

```bash
mkdir -p apk
# place the file at apk/eufy-security.apk or apk/eufy-security.apkm
scripts/install_eufy_apk.sh
```

The install script detects `.apkm` bundles (APKMirror format) and selects the correct ABI split automatically. Eufy ships ARM64-only native libraries, so the script always uses the `arm64-v8a` split regardless of host architecture.

## Web API

- `GET /api/health`
- `GET /api/images?date=YYYY-MM-DD`
- `GET /api/images/latest`
- `GET /images/<relative-path>`
