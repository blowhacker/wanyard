# Wanyard

RTSP/HLS camera capture with YOLO object detection and a LAN web viewer.

## Quick start

```bash
git clone https://github.com/blowhacker/wanyard.git
cd wanyard
docker compose up --build -d
```

Open `http://localhost:8091/settings` to add cameras. YOLO model downloads automatically on first run.

For GPU acceleration, copy the override file:

```bash
cp docker-compose.gpu.yml docker-compose.override.yml
docker compose up --build -d
```

## What it does

- Records RTSP camera streams as continuous MP4 segments
- Serves live HLS streams for browser playback
- Runs YOLO inference (real-time on HLS segments, backfill on MP4) with per-class thumbnail crops
- Web UI: live view, timeline filmstrip, event feed with class filtering, clip export
- Auto-cleanup of old footage by age or disk usage

## Architecture

Two containers via `docker-compose.yml`:

- **wanyard** — web server + RTSP recording
- **wanyard-yolo** — YOLO inference, backfill loop, HLS real-time tagging

## Commands

```bash
wanyard serve        # web server + RTSP recording
wanyard yolo-serve   # YOLO inference + backfill (separate process/container)
```

## Configuration

`config.yaml` — cameras can be added via the web UI or in the config file:

```yaml
sources:
  front_door:
    name: Front Door
    type: rtsp
    enabled: true
    url_env: FRONT_DOOR_RTSP_URL
```

Set RTSP URLs in `.env`:

```
FRONT_DOOR_RTSP_URL=rtsp://user:password@camera-ip:554/stream1
```

## Web UI

- `http://localhost:8091` — timeline viewer with live streams and event feed
- `http://localhost:8091/settings` — system status, camera management, cleanup config
