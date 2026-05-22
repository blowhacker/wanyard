FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libavif-bin libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1

COPY pyproject.toml requirements.txt README.md ./
COPY src ./src
RUN pip install --no-cache-dir \
      torch torchvision \
      --index-url https://download.pytorch.org/whl/cu121 \
  && pip install --no-cache-dir .

COPY config.yaml ./config.yaml
COPY healthcheck.sh ./healthcheck.sh

EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD sh /app/healthcheck.sh
ENTRYPOINT ["eufy-snapshot"]
CMD ["serve"]
