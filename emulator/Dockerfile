FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android
ENV ANDROID_AVD_HOME=/avd
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-current
ENV PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

ARG ANDROID_API=34
ARG CMDTOOLS_BUILD=11076708

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    wget unzip ca-certificates \
    libpulse0 libgl1 libegl1 libgles2 libx11-6 libxext6 \
    xvfb x11vnc \
    python3 python3-pip \
    procps \
    && ln -sf /usr/lib/jvm/java-17-openjdk-$(dpkg --print-architecture) /usr/lib/jvm/java-17-openjdk-current \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir websockify

RUN wget -q "https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz" -O /tmp/novnc.tar.gz \
    && tar -xzf /tmp/novnc.tar.gz -C /opt \
    && mv /opt/noVNC-1.4.0 /opt/novnc \
    && rm /tmp/novnc.tar.gz

RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && wget -q "https://dl.google.com/android/repository/commandlinetools-linux-${CMDTOOLS_BUILD}_latest.zip" \
         -O /tmp/cmdtools.zip \
    && unzip -q /tmp/cmdtools.zip -d "$ANDROID_HOME/cmdline-tools" \
    && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/cmdtools.zip

RUN yes | sdkmanager --licenses >/dev/null 2>&1 || true

# ARM64 system image — ~2 GB, baked into image so no download at runtime
RUN sdkmanager \
    "platform-tools" \
    "emulator" \
    "platforms;android-${ANDROID_API}" \
    "system-images;android-${ANDROID_API};google_apis;arm64-v8a"

ENV ANDROID_API=${ANDROID_API}

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 5555 6080

CMD ["/start.sh"]
