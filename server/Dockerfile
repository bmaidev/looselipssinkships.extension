# LLSS OCR Extraction Server
# Tesseract 5 + Poppler for high-fidelity PDF/image OCR.
# Returns text + bounding boxes — NO PII detection.
#
# Build:  docker build -t llss-ocr .
# Run:    docker run --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
#           -e LLSS_API_KEY='replace-with-a-random-32+-character-key' \
#           -p 127.0.0.1:8000:8000 llss-ocr

FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

# Install only the OCR and PDF conversion runtimes used by the service.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY main.py .

RUN groupadd --system llss && useradd --system --gid llss --home-dir /nonexistent --shell /usr/sbin/nologin llss

USER llss

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"]

# OCR is memory/CPU intensive; one worker prevents request fan-out from
# multiplying peak resource consumption inside a single container.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "4", "--timeout-keep-alive", "5", "--no-access-log"]
