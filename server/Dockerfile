# LLSS OCR Extraction Server
# Tesseract 5 + Poppler for high-fidelity PDF/image OCR.
# Returns text + bounding boxes — NO PII detection.
#
# Build:  docker build -t llss-ocr .
# Run:    docker run -p 8000:8000 llss-ocr

FROM python:3.12-slim

# Install Tesseract 5, Poppler (pdf2image), and image libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8000

# Run with 4 workers for concurrent requests
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
