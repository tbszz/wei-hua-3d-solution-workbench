"""Read text that a drawing carries as exploded curves rather than TEXT entities.

stdin : {"strokes": [[[x, y], ...], ...], "unit": <median glyph-stroke size, mm>}
stdout: {"labels": [{"text", "score", "x", "y", "width", "height"}]}  (mm, drawing coordinates)
        or {"error": "..."} with a non-zero exit code.

The strokes are drawn black on white at a scale where one glyph stroke spans ~10 px (a
character ends up 40-70 px tall), tiled when the drawing is large, and handed to RapidOCR.
"""
import json
import sys

TILE = 4096
OVERLAP = 512
PX_PER_UNIT = 10.0
MAX_SIDE = 40000


def fail(message):
    print(json.dumps({"error": message}, ensure_ascii=False))
    sys.exit(2)


def main():
    try:
        import numpy as np
        from PIL import Image, ImageDraw
        from rapidocr_onnxruntime import RapidOCR
    except Exception as error:  # noqa: BLE001 - report any import problem to the caller
        fail(f"本机缺少 OCR 依赖（pip install rapidocr_onnxruntime pillow numpy）：{error}")

    payload = json.load(sys.stdin)
    strokes = [s for s in payload.get("strokes", []) if len(s) >= 2]
    unit = float(payload.get("unit") or 0)
    if not strokes or unit <= 0:
        print(json.dumps({"labels": []}))
        return

    xs = [p[0] for s in strokes for p in s]
    ys = [p[1] for s in strokes for p in s]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    pad = 40
    scale = PX_PER_UNIT / unit
    scale = min(scale, (MAX_SIDE - 2 * pad) / max(x1 - x0, y1 - y0, 1e-9))
    width = int((x1 - x0) * scale) + 2 * pad
    height = int((y1 - y0) * scale) + 2 * pad

    image = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(image)
    for stroke in strokes:
        draw.line([((x - x0) * scale + pad, height - ((y - y0) * scale + pad)) for x, y in stroke], fill=0, width=2)
    pixels = np.array(image)

    ocr = RapidOCR()
    found = []
    step = TILE - OVERLAP
    for top in range(0, max(1, height - OVERLAP), step):
        for left in range(0, max(1, width - OVERLAP), step):
            tile = pixels[top:top + TILE, left:left + TILE]
            if tile.min() == 255:
                continue
            result, _ = ocr(np.stack([tile] * 3, -1))
            for box, text, score in result or []:
                bx = [p[0] + left for p in box]
                by = [p[1] + top for p in box]
                found.append({
                    "text": text,
                    "score": round(float(score), 3),
                    "x": round((sum(bx) / 4 - pad) / scale + x0, 1),
                    "y": round((height - sum(by) / 4 - pad) / scale + y0, 1),
                    "width": round((max(bx) - min(bx)) / scale, 1),
                    "height": round((max(by) - min(by)) / scale, 1),
                })

    # Tiles overlap: keep one copy of a label read twice.
    labels = []
    for item in sorted(found, key=lambda f: -f["score"]):
        if any(o["text"] == item["text"] and abs(o["x"] - item["x"]) < item["height"] and abs(o["y"] - item["y"]) < item["height"] for o in labels):
            continue
        labels.append(item)
    print(json.dumps({"labels": labels}, ensure_ascii=False))


if __name__ == "__main__":
    main()
