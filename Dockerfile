FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libavif-bin libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1

# Heavy deps — cached unless requirements.txt changes
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App deps — cached unless pyproject.toml changes
COPY pyproject.toml README.md ./
RUN python -c 'import tomllib; print("\n".join(tomllib.load(open("pyproject.toml", "rb"))["project"]["dependencies"]))' > /tmp/deps.txt \
  && pip install --no-cache-dir -r /tmp/deps.txt

# App code
COPY src ./src
RUN pip install --no-cache-dir --no-build-isolation --no-deps .

COPY config.yaml ./config.yaml
COPY healthcheck.sh ./healthcheck.sh

EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD sh /app/healthcheck.sh
ENTRYPOINT ["wanyard"]
CMD ["serve"]
