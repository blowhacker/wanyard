# Eufy Snapshot

Capture camera-only screenshots from the Eufy Android app through ADB and serve a LAN web viewer for recent snapshots.

## Assumptions

- Android emulator is managed by the host, not Docker.
- Eufy is installed, logged in, permissions are granted, and the target camera live view is open.
- Capture uses the in-app Screenshot/scissors button, configured as tap coordinates in `config.yaml`.

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

## Web API

- `GET /api/health`
- `GET /api/images?date=YYYY-MM-DD`
- `GET /api/images/latest`
- `GET /images/<relative-path>`
