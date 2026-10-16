"""
OCR Extraction Server for Loose Lips Sink Ships.

A lightweight FastAPI service that extracts text + bounding boxes from
PDF and image files using Tesseract 5 and Poppler.

IMPORTANT: This server performs ONLY text extraction — no PII detection.
PII detection always happens in the browser extension (local-first).

Endpoints:
    GET  /healthz — Unauthenticated liveness check
    POST /extract — Extract text and bounding boxes from a document

Deployment:
    docker compose up -d

Environment Variables:
    LLSS_API_KEY        — Bearer key fallback (minimum 32 characters)
    LLSS_API_KEY_FILE   — Preferred path to a mounted bearer-key secret
    LLSS_CORS_ORIGINS   — Optional comma-separated extension/web origins
    LLSS_MAX_FILE_SIZE  — Maximum upload size in bytes (default/max: 25MiB)
    LLSS_MAX_PAGES      — Maximum PDF pages to process (default: 50)
    LLSS_TESSERACT_LANG — OCR language(s) (default: "eng")
    LLSS_DPI            — PDF rendering DPI (default: 250, max: 300)
    LLSS_OCR_TIMEOUT    — Per-Tesseract-call timeout seconds (default: 60)
    LLSS_PDF_TIMEOUT    — PDF inspection/render timeout seconds (default: 120)
    LLSS_MAX_IMAGE_PIXELS — Image/page decompression limit (default/max: 40M)
"""

import io
import logging
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
import pytesseract
from pdf2image import convert_from_bytes, pdfinfo_from_bytes
from pdf2image.exceptions import PDFPageCountError, PDFPopplerTimeoutError

LOGGER = logging.getLogger("llss-ocr")


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _load_api_key() -> str:
    """Load one bearer key without exposing it through process arguments."""
    key_file = os.getenv("LLSS_API_KEY_FILE", "").strip()
    environment_key = os.getenv("LLSS_API_KEY", "")
    if key_file and environment_key:
        raise RuntimeError("Set only one of LLSS_API_KEY_FILE or LLSS_API_KEY")

    if key_file:
        try:
            path = Path(key_file)
            metadata = path.stat()
            if not path.is_file() or metadata.st_size == 0 or metadata.st_size > 4096:
                raise RuntimeError("LLSS_API_KEY_FILE must reference a small regular file")
            if metadata.st_mode & 0o022:
                raise RuntimeError("LLSS_API_KEY_FILE must not be group- or world-writable")
            key = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            raise RuntimeError("Unable to read LLSS_API_KEY_FILE") from exc
    else:
        key = environment_key

    if len(key) < 32:
        raise RuntimeError("The OCR API key must be a random value of at least 32 characters")
    return key


class RequestSizeLimitMiddleware:
    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") != "/extract":
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        try:
            declared_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared_length = self.max_bytes + 1
        if declared_length < 0 or declared_length > self.max_bytes:
            await self._reject(send)
            return

        # Read at most one bounded request into memory before Starlette's
        # multipart parser can spool form data to disk. Replaying the body
        # avoids throwing across the framework after a response may have
        # started, while still covering HTTP/1.1 chunked bodies that omit a
        # Content-Length header.
        body = bytearray()
        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            if message.get("type") != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await self._reject(send)
                return
            if not message.get("more_body", False):
                break

        replayed = False

        async def replay_receive():
            nonlocal replayed
            if replayed:
                return {"type": "http.disconnect"}
            replayed = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay_receive, send)

    @staticmethod
    async def _reject(send):
        body = b'{"detail":"Request body exceeds the safety limit"}'
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"cache-control", b"no-store"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": body})


def _load_cors_origins() -> list[str]:
    origins = []
    for raw_origin in os.getenv("LLSS_CORS_ORIGINS", "").split(","):
        origin = raw_origin.strip().rstrip("/")
        if not origin:
            continue
        parsed = urlsplit(origin)
        loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        allowed_scheme = parsed.scheme in {"https", "chrome-extension", "extension", "moz-extension"}
        if parsed.scheme == "http" and loopback:
            allowed_scheme = True
        if (origin == "*" or not allowed_scheme or not parsed.hostname or
                parsed.username or parsed.password or parsed.query or parsed.fragment or
                parsed.path not in {"", "/"}):
            raise RuntimeError("LLSS_CORS_ORIGINS contains an unsafe or invalid origin")
        origins.append(origin)
    return list(dict.fromkeys(origins))

app = FastAPI(
    title="LLSS OCR Extraction Server",
    version="1.1.0",
    description="Extracts text + bounding boxes from documents. No PII detection.",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

MAX_FILE_SIZE = _bounded_int("LLSS_MAX_FILE_SIZE", 25 * 1024 * 1024, 1, 25 * 1024 * 1024)
MAX_PAGES = _bounded_int("LLSS_MAX_PAGES", 50, 1, 50)
TESSERACT_LANG = os.getenv("LLSS_TESSERACT_LANG", "eng")
DPI = _bounded_int("LLSS_DPI", 250, 100, 300)
OCR_TIMEOUT_SECONDS = _bounded_int("LLSS_OCR_TIMEOUT", 60, 5, 180)
PDF_TIMEOUT_SECONDS = _bounded_int("LLSS_PDF_TIMEOUT", 120, 10, 300)
MAX_IMAGE_PIXELS = _bounded_int("LLSS_MAX_IMAGE_PIXELS", 40_000_000, 1_000_000, 40_000_000)
API_KEY = _load_api_key()
if not re.fullmatch(r"[A-Za-z0-9_+.-]{1,64}", TESSERACT_LANG):
    raise RuntimeError("LLSS_TESSERACT_LANG contains unsupported characters")

# Include bounded multipart overhead but reject oversized bodies before Starlette
# can spool them to disk.
app.add_middleware(RequestSizeLimitMiddleware, max_bytes=MAX_FILE_SIZE + 1024 * 1024)

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

cors_origins = _load_cors_origins()
if cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_methods=["POST"],
        allow_headers=["Authorization", "Content-Type"],
        allow_credentials=False,
    )


def require_api_key(authorization: str = Header(default="")) -> None:
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(credential, API_KEY):
        raise HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})


@app.get("/healthz")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "llss-ocr", "version": "1.1.0"}


@app.post("/extract")
async def extract(
    response: Response,
    _authenticated: None = Depends(require_api_key),
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
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    data = bytearray()
    while chunk := await file.read(1024 * 1024):
        data.extend(chunk)
        if len(data) > MAX_FILE_SIZE:
            raise HTTPException(413, f"File too large. Maximum: {MAX_FILE_SIZE // (1024*1024)}MB")
    if not data:
        raise HTTPException(400, "File is empty")
    data = bytes(data)

    # Detect type
    ct = content_type or file.content_type or ""
    filename = file.filename or ""
    ext = Path(filename).suffix.lower()

    claimed_pdf = "pdf" in ct or ext == ".pdf"
    claimed_image = ct.startswith("image/") or ext in {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
    }
    is_pdf = claimed_pdf and data.startswith(b"%PDF-")
    image_signatures = (
        b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"BM", b"II*\x00", b"MM\x00*"
    )
    is_webp = data.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WEBP"
    is_image = claimed_image and (data.startswith(image_signatures) or is_webp)

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
    except HTTPException:
        raise
    except Exception:
        LOGGER.exception("OCR processing failed")
        raise HTTPException(500, "OCR processing failed")

    full_text = "\n".join(p["text"] for p in pages)
    return {"pages": pages, "fullText": full_text}


def _process_pdf(data: bytes) -> list:
    """Convert PDF pages to images, then OCR each."""
    try:
        info = pdfinfo_from_bytes(data, timeout=PDF_TIMEOUT_SECONDS)
    except PDFPopplerTimeoutError as exc:
        raise HTTPException(408, "PDF inspection timed out") from exc
    except PDFPageCountError as exc:
        raise HTTPException(400, "PDF structure is invalid") from exc
    page_count = int(info.get("Pages", 0))
    if page_count < 1 or page_count > MAX_PAGES:
        raise HTTPException(400, f"PDF must contain between 1 and {MAX_PAGES} pages")
    pages = []
    for page_number in range(1, page_count + 1):
        try:
            images = convert_from_bytes(
                data,
                dpi=DPI,
                fmt="png",
                first_page=page_number,
                last_page=page_number,
                timeout=PDF_TIMEOUT_SECONDS,
                thread_count=1,
            )
        except PDFPopplerTimeoutError as exc:
            raise HTTPException(408, "PDF rendering timed out") from exc
        if len(images) != 1:
            raise HTTPException(400, "PDF page could not be rendered")
        img = images[0]
        try:
            if img.width * img.height > MAX_IMAGE_PIXELS:
                raise HTTPException(400, "Rendered PDF page exceeds the pixel safety limit")
            result = _ocr_image(img)
            result["pageNumber"] = page_number
            result["width"] = img.width
            result["height"] = img.height
            pages.append(result)
        finally:
            img.close()
    return pages


def _process_image(data: bytes) -> list:
    """OCR a single image."""
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as img:
            if img.width * img.height > MAX_IMAGE_PIXELS:
                raise HTTPException(400, "Image exceeds the pixel safety limit")
            result = _ocr_image(img)
            result["pageNumber"] = 1
            result["width"] = img.width
            result["height"] = img.height
            return [result]
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as exc:
        raise HTTPException(400, "Image is invalid or exceeds decoder safety limits") from exc


def _ocr_image(img: Image.Image) -> dict:
    """Run Tesseract OCR on a PIL image, returning text + bounding boxes."""
    # One Tesseract invocation provides words, confidence, and bounding boxes.
    # Deriving text from the same TSV keeps offsets aligned for pixel mapping.
    tsv_data = pytesseract.image_to_data(
        img,
        lang=TESSERACT_LANG,
        output_type=pytesseract.Output.DICT,
        timeout=OCR_TIMEOUT_SECONDS,
    )

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

    text = "\n".join(block["text"] for block in blocks)
    return {"text": text.strip(), "blocks": blocks}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
