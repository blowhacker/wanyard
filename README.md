# Wanyard

RTSP/HLS camera capture with YOLO object detection and a LAN web viewer.

## What it does

- Records RTSP camera streams as continuous MP4 segments
- Serves live HLS streams for browser playback
- Runs YOLO inference (real-time on HLS segments, backfill on MP4) with per-class thumbnail crops
- Web UI: live view, timeline filmstrip, event feed with class filtering, clip export
- Auto-cleanup of old footage by age or disk usage

## Setup

```bash
pip install -e .
wanyard -c config.yaml serve
```

## Sources

Configure cameras in `config.yaml`:

```yaml
sources:
  front_door:
    name: Front Door
    type: rtsp
    enabled: true
    interval_seconds: 30
    output_subdir: front_door
    url_env: FRONT_DOOR_RTSP_URL
    rtsp_transport: tcp
    timeout_seconds: 20
```

Set the RTSP URL in the environment:

```bash
FRONT_DOOR_RTSP_URL=rtsp://user:password@camera-ip:554/stream1
```

Sources can also be added at runtime through the web UI settings page.

## Commands

```bash
wanyard serve        # web server + RTSP recording
wanyard yolo-serve   # YOLO inference + backfill (separate process/container)
```

## Docker

```bash
docker build -t wanyard .
docker run --rm -p 8091:8091 \
  -v "$PWD/config.yaml:/app/config.yaml" \
  -v "$PWD/video:/app/video" \
  wanyard serve
```

## Docker Compose (production)

`docker-compose.banana.yml` runs two services:

- **yolo** — GPU container running `wanyard yolo-serve` (YOLO model, backfill loop, HLS tagging)
- **app** — web server running `wanyard serve` (recording, web UI, API)

```bash
docker compose -f docker-compose.banana.yml up -d
```

Requires NVIDIA GPU runtime for the yolo service.

## Web UI

- `http://localhost:8091` — timeline viewer with live streams and event feed
- `http://localhost:8091/settings` — system status, camera management, cleanup config
