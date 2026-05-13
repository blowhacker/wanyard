FROM python:3.12-slim

ARG PLATFORM_TOOLS_URL=https://dl.google.com/android/repository/platform-tools-latest-linux.zip

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg libavif-bin libgl1 libglib2.0-0 unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "$PLATFORM_TOOLS_URL" -o /tmp/platform-tools.zip \
  && unzip /tmp/platform-tools.zip -d /opt \
  && rm /tmp/platform-tools.zip

ENV PATH="/opt/platform-tools:${PATH}" \
    PYTHONUNBUFFERED=1

COPY pyproject.toml requirements.txt README.md ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY config.yaml ./config.yaml

EXPOSE 8091
ENTRYPOINT ["eufy-snapshot"]
CMD ["serve"]
