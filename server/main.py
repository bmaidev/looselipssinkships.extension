"""
OCR Extraction Server for Loose Lips Sink Ships.

A lightweight FastAPI service that extracts text + bounding boxes from
PDF and image files using Tesseract 5 and Poppler.

IMPORTANT: This server performs ONLY text extraction — no PII detection.
PII detection always happens in the browser extension (local-first).

Endpoints:
    POST /extract — Extract text and bounding boxes from a document

Deployment:
    docker-compose up -d

Environment Variables:
    LLSS_MAX_FILE_SIZE  — Maximum upload size in bytes (default: 50MB)
    LLSS_MAX_PAGES      — Maximum PDF pages to process (default: 50)
    LLSS_TESSERACT_LANG — OCR language(s) (default: "eng")
    LLSS_DPI            — PDF rendering DPI (default: 300)
"""

import io
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import pytesseract
from pdf2image import convert_from_bytes

app = FastAPI(
    title="LLSS OCR Extraction Server",
    version="1.0.0",
    description="Extracts text + bounding boxes from documents. No PII detection.",
)

# CORS — allow the extension to connect from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

MAX_FILE_SIZE = int(os.getenv("LLSS_MAX_FILE_SIZE", 50 * 1024 * 1024))  # 50MB
MAX_PAGES = int(os.getenv("LLSS_MAX_PAGES", 50))
TESSERACT_LANG = os.getenv("LLSS_TESSERACT_LANG", "eng")
DPI = int(os.getenv("LLSS_DPI", 300))


@app.get("/")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "llss-ocr", "version": "1.0.0"}


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    content_type: str = Form(default=""),
):
    """
    Extract text and bounding boxes from a PDF or image.

    Returns:
        {
            "pages": [
                {
                    "pageNumber": 1,
                    "width": 2480,
                    "height": 3508,
                    "text": "Full page text...",
                    "blocks": [
                        {
                            "text": "John Smith",
                            "bbox": {"x": 100, "y": 200, "w": 300, "h": 40},
                            "confidence": 95.2,
                            "words": [
                                {"text": "John", "bbox": {"x": 100, "y": 200, "w": 140, "h": 40}, "confidence": 96.1},
                                {"text": "Smith", "bbox": {"x": 250, "y": 200, "w": 150, "h": 40}, "confidence": 94.3}
                            ]
                        }
                    ]
                }
            ],
            "fullText": "Combined text from all pages..."
        }
    """
    data = await file.read()
    if len(data) > MAX_FILE_SIZE:
        raise HTTPException(413, f"File too large. Maximum: {MAX_FILE_SIZE // (1024*1024)}MB")

    # Detect type
    ct = content_type or file.content_type or ""
    filename = file.filename or ""
    ext = Path(filename).suffix.lower()

    is_pdf = "pdf" in ct or ext == ".pdf"
    is_image = ct.startswith("image/") or ext in {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
    }

    if not is_pdf and not is_image:
        raise HTTPException(
            400,
            f"Unsupported file type: {ct or ext}. Supported: PDF, PNG, JPEG, GIF, WebP, BMP, TIFF.",
        )

    try:
        if is_pdf:
            pages = _process_pdf(data)
        else:
            pages = _process_image(data)
    except Exception as e:
        raise HTTPException(500, f"OCR processing failed: {e}")

    full_text = "\n".join(p["text"] for p in pages)
    return {"pages": pages, "fullText": full_text}


def _process_pdf(data: bytes) -> list:
    """Convert PDF pages to images, then OCR each."""
    images = convert_from_bytes(data, dpi=DPI, fmt="png")
    pages = []
    for i, img in enumerate(images[:MAX_PAGES], start=1):
        result = _ocr_image(img)
        result["pageNumber"] = i
        result["width"] = img.width
        result["height"] = img.height
        pages.append(result)
    return pages


def _process_image(data: bytes) -> list:
    """OCR a single image."""
    img = Image.open(io.BytesIO(data))
    result = _ocr_image(img)
    result["pageNumber"] = 1
    result["width"] = img.width
    result["height"] = img.height
    return [result]


def _ocr_image(img: Image.Image) -> dict:
    """Run Tesseract OCR on a PIL image, returning text + bounding boxes."""
    # Get full text
    text = pytesseract.image_to_string(img, lang=TESSERACT_LANG)

    # Get word-level bounding boxes via TSV output
    tsv_data = pytesseract.image_to_data(img, lang=TESSERACT_LANG, output_type=pytesseract.Output.DICT)

    # Group words into lines
    lines = {}
    n = len(tsv_data["text"])
    for i in range(n):
        word_text = tsv_data["text"][i].strip()
        if not word_text:
            continue

        line_num = tsv_data["line_num"][i]
        block_num = tsv_data["block_num"][i]
        par_num = tsv_data["par_num"][i]
        line_key = (block_num, par_num, line_num)

        conf = float(tsv_data["conf"][i])
        word = {
            "text": word_text,
            "bbox": {
                "x": tsv_data["left"][i],
                "y": tsv_data["top"][i],
                "w": tsv_data["width"][i],
                "h": tsv_data["height"][i],
            },
            "confidence": conf,
        }

        if line_key not in lines:
            lines[line_key] = {"words": [], "text_parts": []}
        lines[line_key]["words"].append(word)
        lines[line_key]["text_parts"].append(word_text)

    # Build blocks (one per line)
    blocks = []
    for line_key in sorted(lines.keys()):
        line = lines[line_key]
        words = line["words"]
        line_text = " ".join(line["text_parts"])

        # Compute line bounding box from word bboxes
        x1 = min(w["bbox"]["x"] for w in words)
        y1 = min(w["bbox"]["y"] for w in words)
        x2 = max(w["bbox"]["x"] + w["bbox"]["w"] for w in words)
        y2 = max(w["bbox"]["y"] + w["bbox"]["h"] for w in words)
        avg_conf = sum(w["confidence"] for w in words) / len(words)

        blocks.append({
            "text": line_text,
            "bbox": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
            "confidence": round(avg_conf, 1),
            "words": words,
        })

    return {"text": text.strip(), "blocks": blocks}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
