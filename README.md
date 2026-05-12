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
eufy-snapshot run
eufy-snapshot web
eufy-snapshot serve
```

`serve` runs both the capture worker and the web viewer.

## Docker

The image includes Python app code and Android platform tools. The emulator remains on the host.

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

`docker-compose.yml` runs an Android 14/API 34 emulator container plus the snapshot app container.

```bash
docker compose up --build
```

Open:

- Web viewer: `http://localhost:8091`
- Emulator noVNC: `http://localhost:6080`

The Compose stack uses `config.compose.yaml`, where ADB points at the emulator service:

```yaml
adb_serial: eufy-emulator:5555
adb_connect: eufy-emulator:5555
```

After the emulator boots, install Eufy and log in through noVNC. To sideload a user-supplied APK:

```bash
mkdir -p apk
# place the APK at apk/eufy-security.apk
scripts/install_eufy_apk.sh
```

Important platform note: the bundled emulator image needs hardware virtualization through `/dev/kvm`. This works on Linux hosts with KVM enabled. Docker Desktop on macOS generally cannot pass `/dev/kvm` through to Linux containers, so on macOS the reliable path is still the host-managed Android Studio emulator plus `docker run` for the app.

## Web API

- `GET /api/health`
- `GET /api/images?date=YYYY-MM-DD`
- `GET /api/images/latest`
- `GET /images/<relative-path>`
