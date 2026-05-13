FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libavif-bin libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1

COPY pyproject.toml requirements.txt README.md ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY config.yaml ./config.yaml

EXPOSE 8091
ENTRYPOINT ["eufy-snapshot"]
CMD ["serve"]
