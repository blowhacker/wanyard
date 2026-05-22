#!/bin/sh
# Container healthcheck: verifies web server and recording are functional

# Basic web check
curl -sf http://localhost:8091/api/health > /dev/null || exit 1

# Check recording threads and yolo via settings status
python3 -c "
import urllib.request, json, sys, time

try:
    r = urllib.request.urlopen('http://localhost:8091/api/settings/status', timeout=5)
    d = json.load(r)
except Exception as e:
    print('status fetch failed:', e)
    sys.exit(1)

# Verify recording threads alive (if any configured)
threads = d.get('recording_threads', {})
dead = [k for k,v in threads.items() if not v]
if dead:
    print('dead recording threads:', dead)
    sys.exit(1)
" || exit 1

# Check HLS is updating: m3u8 should be < 60s old if cameras are configured
VIDEO_DIR=${VIDEO_DIR:-/app/video}
for cam_dir in "$VIDEO_DIR/live"/*/; do
    m3u8="$cam_dir/live.m3u8"
    if [ -f "$m3u8" ]; then
        age=$(( $(date +%s) - $(stat -c %Y "$m3u8" 2>/dev/null || echo 0) ))
        if [ "$age" -gt 60 ]; then
            echo "HLS stale for $(basename $cam_dir): ${age}s old"
            exit 1
        fi
    fi
done

exit 0
