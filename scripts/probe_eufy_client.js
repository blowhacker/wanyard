#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  EufySecurity,
  P2PConnectionType,
  PropertyName,
  VideoCodec,
} = require("eufy-security-client");

const persistentDir = process.env.EUFY_PERSISTENT_DIR || "persist";
const outputDir = process.env.EUFY_PROBE_OUTPUT_DIR || "/tmp/eufy-probe-output";
const targetSerial = process.env.EUFY_DEVICE_SERIAL || "";
const targetName = (process.env.EUFY_DEVICE_NAME || "").toLowerCase();
const waitAfterConnectMs = Number(process.env.EUFY_WAIT_AFTER_CONNECT_MS || 12000);
const imageWaitMs = Number(process.env.EUFY_IMAGE_WAIT_MS || 20000);
const streamWaitMs = Number(process.env.EUFY_STREAM_WAIT_MS || 45000);
const captchaCode = process.env.EUFY_CAPTCHA_CODE || "";
const captchaId = process.env.EUFY_CAPTCHA_ID || "";
const stationIp = process.env.EUFY_STATION_IP || "";
const p2pMode = (process.env.EUFY_P2P_MODE || "QUICKEST").toUpperCase();

fs.mkdirSync(persistentDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

process.on("exit", (code) => {
  log("process exit", code);
});

function describeDevice(device) {
  return {
    name: device.getName(),
    serial: device.getSerial(),
    stationSerial: device.getStationSerial(),
    model: device.getModel(),
    type: device.getDeviceType(),
    channel: device.getChannel(),
    isCamera: device.isCamera(),
    isDoorbell: device.isDoorbell(),
    isBatteryDoorbellC31: device.isBatteryDoorbellC31(),
    isBatteryDoorbellC30: device.isBatteryDoorbellC30(),
  };
}

function shortError(error) {
  if (!error) return "unknown error";
  const parts = [error.stack || error.message || String(error)];
  if (error.context) {
    parts.push(`context=${JSON.stringify(error.context)}`);
  }
  if (error.cause) {
    parts.push(`cause=${error.cause.stack || error.cause.message || String(error.cause)}`);
    if (error.cause.context) {
      parts.push(`cause.context=${JSON.stringify(error.cause.context)}`);
    }
    if (error.cause.response) {
      parts.push(`cause.response.status=${error.cause.response.status}`);
      parts.push(`cause.response.data=${JSON.stringify(error.cause.response.data).slice(0, 500)}`);
    }
  }
  if (error.response) {
    parts.push(`response.status=${error.response.status}`);
    parts.push(`response.data=${JSON.stringify(error.response.data).slice(0, 500)}`);
  }
  return parts.join("\n");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    wait(ms).then(() => fallback),
  ]);
}

function createClientReadyWaiter(eufy, ms) {
  let settled = false;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const keepAlive = setInterval(() => {}, 1000);
  const timeout = setTimeout(() => finish(false), ms);
  function finish(value) {
    if (settled) return;
    settled = true;
    clearInterval(keepAlive);
    clearTimeout(timeout);
    eufy.off("connect", onConnect);
    eufy.off("connection error", onError);
    resolvePromise(value);
  }
  function onConnect() {
    log("client connect event");
    finish(true);
  }
  function onError(error) {
    log("client connection error", shortError(error));
  }
  eufy.on("connect", onConnect);
  eufy.on("connection error", onError);
  return {
    promise,
    cancel: () => finish(false),
  };
}

function savePicture(prefix, picture) {
  if (!picture || !picture.data) return null;
  const ext = picture.type && picture.type.ext && picture.type.ext !== "unknown"
    ? picture.type.ext
    : "jpg";
  const file = path.join(outputDir, `${prefix}.${ext}`);
  fs.writeFileSync(file, picture.data);
  log("saved picture", file, picture.data.length, "bytes", picture.type || {});
  return file;
}

function saveCaptcha(id, captcha) {
  fs.writeFileSync(path.join(outputDir, "captcha-id.txt"), id || "");
  if (!captcha) {
    log("captcha requested", id || "<no id>", "without image payload");
    return;
  }

  let data = String(captcha);
  let ext = "txt";
  let content = Buffer.from(data, "utf8");
  const dataUrlMatch = data.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (dataUrlMatch) {
    ext = dataUrlMatch[1].replace("jpeg", "jpg");
    content = Buffer.from(dataUrlMatch[2], "base64");
  } else if (/^[A-Za-z0-9+/=]+$/.test(data) && data.length > 100) {
    ext = "jpg";
    content = Buffer.from(data, "base64");
  }

  const file = path.join(outputDir, `captcha.${ext}`);
  fs.writeFileSync(file, content);
  log("captcha requested", id || "<no id>", "saved", file);
}

function chooseDevice(devices) {
  if (targetSerial) {
    return devices.find((device) => device.getSerial() === targetSerial);
  }
  if (targetName) {
    return devices.find((device) => device.getName().toLowerCase().includes(targetName));
  }
  return (
    devices.find((device) => device.isBatteryDoorbellC31()) ||
    devices.find((device) => device.isBatteryDoorbellC30()) ||
    devices.find((device) => device.isDoorbell()) ||
    devices.find((device) => device.isCamera())
  );
}

async function main() {
  const logger = {
    debug: () => {},
    trace: () => {},
    info: (...args) => log("[info]", ...args),
    warn: (...args) => log("[warn]", ...args),
    error: (...args) => log("[error]", ...args.map((arg) => String(arg).slice(0, 500))),
  };

  const eufy = await EufySecurity.initialize(
    {
      username: process.env.EUFY_EMAIL,
      password: process.env.EUFY_PASSWORD,
      country: process.env.EUFY_COUNTRY || "GB",
      language: process.env.EUFY_LANGUAGE || "en",
      persistentDir,
      p2pConnectionSetup: p2pMode === "ONLY_LOCAL" ? P2PConnectionType.ONLY_LOCAL : P2PConnectionType.QUICKEST,
      pollingIntervalMinutes: 10,
      eventDurationSeconds: 10,
      acceptInvitations: false,
      stationIPAddresses: stationIp && targetSerial ? { [targetSerial]: stationIp } : undefined,
    },
    logger
  );
  if (stationIp && targetSerial) {
    log("using station IP override", targetSerial, stationIp);
  } else if (stationIp) {
    log("station IP override ignored because EUFY_DEVICE_SERIAL is not set");
  }
  log("using P2P mode", p2pMode === "ONLY_LOCAL" ? "ONLY_LOCAL" : "QUICKEST");

  let selectedDevice = null;
  let gotPhoto = false;
  let gotVideoBytes = false;
  let streamDone = false;
  const seenStations = new Map();
  const seenDevices = new Map();
  let captchaRequested = false;

  eufy.on("tfa request", () => log("2FA requested; set up persistent auth before headless probing."));
  eufy.on("captcha request", (id, captcha) => {
    captchaRequested = true;
    saveCaptcha(id, captcha);
  });
  eufy.on("station added", (station) => {
    seenStations.set(station.getSerial(), station);
    log("station added", station.getName(), station.getSerial(), station.getModel(), station.getDeviceType());
  });
  eufy.on("device added", (device) => {
    seenDevices.set(device.getSerial(), device);
    log("device added", JSON.stringify(describeDevice(device)));
  });
  eufy.on("station connection error", (station, error) => {
    log("station connection error", station && station.getSerial && station.getSerial(), shortError(error));
  });
  eufy.on("station connect", (station) => {
    log("station connected", station.getName(), station.getSerial());
  });
  eufy.on("station close", (station) => {
    log("station closed", station.getName(), station.getSerial());
  });
  eufy.on("station image download", (_station, file, picture) => {
    log("station image download", file);
    const saved = savePicture("downloaded-picture", picture);
    if (saved) gotPhoto = true;
  });
  eufy.on("station livestream start", (station, device, metadata, videoStream) => {
    log("livestream started", station.getSerial(), device.getSerial(), JSON.stringify(metadata));
    const h264Path = path.join(outputDir, "livestream.h264");
    const writeStream = fs.createWriteStream(h264Path);
    let chunks = 0;
    let bytes = 0;
    videoStream.on("data", (chunk) => {
      chunks += 1;
      bytes += chunk.length;
      gotVideoBytes = true;
      writeStream.write(chunk);
      if (chunks === 1) {
        log("first video chunk", chunk.length, "bytes");
      }
    });
    videoStream.on("error", (error) => log("video stream error", shortError(error)));
    setTimeout(() => {
      writeStream.end();
      try {
        station.stopLivestream(device);
      } catch (error) {
        log("stop livestream failed", shortError(error));
      }
      log("livestream capture finished", h264Path, bytes, "bytes", chunks, "chunks");
      streamDone = true;
    }, 8000);
  });
  eufy.on("station livestream stop", (_station, device) => {
    log("livestream stopped", device.getSerial());
    streamDone = true;
  });
  eufy.on("station livestream error", (_station, device, error) => {
    log("livestream error", device && device.getSerial && device.getSerial(), shortError(error));
    streamDone = true;
  });

  const readyWaiter = createClientReadyWaiter(eufy, 45000);
  const connectOptions = captchaCode
    ? { force: true, captcha: { captchaId, captchaCode } }
    : undefined;
  await eufy.connect(connectOptions);
  log("connect call returned; waiting for client connect event");
  if (captchaRequested && !captchaCode) {
    readyWaiter.cancel();
    throw new Error(`Captcha required. Read ${path.join(outputDir, "captcha-id.txt")} and solve the captcha image in ${outputDir}, then rerun with EUFY_CAPTCHA_ID and EUFY_CAPTCHA_CODE.`);
  }
  const ready = await readyWaiter.promise;
  log("client ready", ready);
  log("waiting after connect", waitAfterConnectMs, "ms");
  await wait(waitAfterConnectMs);
  log("loading stations/devices");

  const stationsFromGetter = await withTimeout(eufy.getStations(), 3000, []);
  const devicesFromGetter = await withTimeout(eufy.getDevices(), 3000, []);
  const stations = stationsFromGetter.length ? stationsFromGetter : Array.from(seenStations.values());
  const devices = devicesFromGetter.length ? devicesFromGetter : Array.from(seenDevices.values());

  log("stations", JSON.stringify(stations.map((station) => ({
    name: station.getName(),
    serial: station.getSerial(),
    model: station.getModel(),
    type: station.getDeviceType(),
    connected: station.isConnected(),
    ip: station.getIPAddress(),
    lanIp: station.getLANIPAddress(),
  })), null, 2));

  log("devices", JSON.stringify(devices.map(describeDevice), null, 2));

  selectedDevice = chooseDevice(devices);
  if (!selectedDevice) {
    throw new Error("No target doorbell/camera found. Set EUFY_DEVICE_SERIAL or EUFY_DEVICE_NAME.");
  }

  log("selected device", JSON.stringify(describeDevice(selectedDevice), null, 2));
  const station = (
    seenStations.get(selectedDevice.getStationSerial()) ||
    stations.find((item) => item.getSerial() === selectedDevice.getStationSerial()) ||
    await withTimeout(eufy.getStation(selectedDevice.getStationSerial()), 3000, null)
  );
  if (!station) {
    throw new Error(`No station found for selected device station ${selectedDevice.getStationSerial()}`);
  }

  const cachedPicture = selectedDevice.getPropertyValue(PropertyName.DevicePicture);
  if (cachedPicture && cachedPicture.data) {
    gotPhoto = Boolean(savePicture("cached-picture", cachedPicture));
  } else {
    log("no cached picture property found");
  }

  const pictureUrl = (
    typeof selectedDevice.getLastCameraImageURL === "function"
      ? selectedDevice.getLastCameraImageURL()
      : selectedDevice.getPropertyValue(PropertyName.DevicePictureUrl)
  );
  log("picture url property", pictureUrl || "<empty>");
  if (pictureUrl) {
    try {
      station.downloadImage(pictureUrl);
      await wait(imageWaitMs);
    } catch (error) {
      log("downloadImage failed", shortError(error));
    }
  }

  if (!gotPhoto) {
    log("trying livestream frame capture");
    try {
      await eufy.startStationLivestream(selectedDevice.getSerial(), VideoCodec.H264);
      const deadline = Date.now() + streamWaitMs;
      while (!streamDone && Date.now() < deadline) {
        await wait(500);
      }
    } catch (error) {
      log("startStationLivestream failed", shortError(error));
    }
  }

  await wait(1000);
  eufy.close();

  if (gotPhoto) {
    log("RESULT photo available");
    process.exit(0);
    return;
  }
  if (gotVideoBytes) {
    log("RESULT video bytes available; convert livestream.h264 to JPEG with ffmpeg");
    process.exit(0);
    return;
  }
  throw new Error("No cached/downloaded picture and no livestream bytes received.");
}

main().catch((error) => {
  console.error(new Date().toISOString(), "RESULT failed", shortError(error));
  process.exit(1);
});
