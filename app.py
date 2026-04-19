import base64
import json
import ssl
import threading
import mimetypes
import os
import threading
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error, request
from urllib.parse import parse_qs, urlparse

from bg_remove import remove_background_from_data_url


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
CERTS_DIR = ROOT / "certs"
UPLOADS_DIR = DATA_DIR / "uploads"
STICKERS_DIR = UPLOADS_DIR / "stickers"
CAPTURES_DIR = UPLOADS_DIR / "captures"
TEMPLATES_FILE = DATA_DIR / "templates.json"
CANVAS_FILE = DATA_DIR / "canvas.json"
ASSETS_FILE = DATA_DIR / "assets.json"
ROOMS_FILE = DATA_DIR / "rooms.json"
HTTPS_CERT_FILE = CERTS_DIR / "tapshow-dev-cert.pem"
HTTPS_KEY_FILE = CERTS_DIR / "tapshow-dev-key.pem"

FIXED_PROMPT_TEMPLATE = """输入两张图：

- 图1：带手绘涂鸦的真人照片，仅用于理解草图与人物位置、五官和装饰语义的关系
- 图2：只有草图本身的图片，仅用于实际贴纸生成

任务要求：
1. 根据图1判断草图画在人物哪里
2. 只基于图2草图进行补全、美化、上色和贴纸化生成
3. 输出 3-4 张不同版本的贴纸图
4. 在保证草图核心语义不变的前提下，尽可能脑洞大开，进行有创意的设计延展，让贴纸更有趣、更可爱、更有惊喜感
5. 生成的贴纸必须可以直接作为“面部贴纸”叠加到真人脸部或头部照片上使用

面部贴纸约束：
- 贴纸必须是正面叠加式设计，适合直接贴在脸上或头上
- 不要生成需要绕到头后方或侧面的结构
- 不要生成不适合贴纸叠加的三维完整实物结构
- 贴纸整体要符合“拍照贴纸/滤镜贴纸”的使用逻辑，而不是现实穿戴物的完整工业结构

创意要求：
- 不要机械复刻草图
- 可以基于草图原意做大胆联想和趣味扩展
- 可以增加夸张但合理的装饰细节、材质、表情感和风格变化
- 可以尝试不同方向的创意版本，例如可爱风、搞怪风、梦幻风、节日风、二次元风、潮流玩具风
- 每张贴纸都要有明显差异，但都要与图1理解出的装饰语义一致
- 最终效果要像可以直接使用的高完成度创意贴纸

输出约束：
- 最终每张图都只包含贴纸本体
- 背景必须是纯色背景
- 不要输出人物
- 不要输出头发、皮肤、五官、身体
- 不要输出原图背景或任何场景
- 不要输出贴纸贴在人物身上的预览效果图
- 贴纸边缘完整清晰，不裁切，不缺边

生成原则：
- 图1只负责理解草图和人物的关系，不参与最终画面输出
- 图2是唯一的生成基础，贴纸必须保留草图的核心轮廓和创意
- 生成结果必须优先满足“可直接贴到脸上/头上使用”的要求
- 可以在颜色、材质、细节、装饰元素和整体风格上大胆发挥
- 输出结果应兼顾“保留原意”“创意升级”和“可直接作为面部贴纸使用”
"""

ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
ARK_MODEL = "doubao-seedream-5-0-260128"
MODEL_CONFIG_FILE = ROOT / "model_config.json"

DISCOVER_TEMPLATES = [
    {
        "id": "preset-cat-ears",
        "name": "猫耳贴纸",
        "description": "适合头顶挂载的萌系猫耳模板。",
        "anchor": "head_top",
        "preview_color": "#ff7aa2",
    },
    {
        "id": "preset-halo",
        "name": "光环贴纸",
        "description": "适合头顶和脸部上方的发光光环。",
        "anchor": "head_top",
        "preview_color": "#ffd36e",
    },
    {
        "id": "preset-bowtie",
        "name": "蝴蝶结贴纸",
        "description": "适合颈部或肩颈区域的蝴蝶结模板。",
        "anchor": "neck",
        "preview_color": "#6ecbff",
    },
]

LOCK = threading.Lock()


@dataclass
class CanvasContext:
    id: str
    image_data_url: str
    width: int
    height: int
    created_at: str
    sketch_points: list[dict[str, float]]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    for path in [STATIC_DIR, DATA_DIR, UPLOADS_DIR, STICKERS_DIR, CAPTURES_DIR]:
        path.mkdir(parents=True, exist_ok=True)
    for json_file in [TEMPLATES_FILE, CANVAS_FILE, ASSETS_FILE, ROOMS_FILE]:
        if not json_file.exists():
            json_file.write_text("[]", encoding="utf-8")


def read_json(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    raw = path.read_text(encoding="utf-8").strip()
    return json.loads(raw) if raw else []


def write_json(path: Path, payload: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def decode_data_url(data_url: str) -> tuple[bytes, str]:
    header, encoded = data_url.split(",", 1)
    mime = header.split(";")[0].replace("data:", "", 1)
    return base64.b64decode(encoded), mime


def normalize_b64_image(image_value: str) -> str:
    if image_value.startswith("data:image/") or image_value.startswith("base64://") or image_value.startswith("http"):
        return image_value
    return f"data:image/png;base64,{image_value}"


def load_model_config() -> dict[str, Any]:
    config: dict[str, Any] = {}
    if MODEL_CONFIG_FILE.exists():
        raw = MODEL_CONFIG_FILE.read_text(encoding="utf-8").strip()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                config = parsed

    api_key = str(config.get("api_key", "") or "").strip()
    if not api_key and (ROOT / ".ark_api_key").exists():
        api_key = (ROOT / ".ark_api_key").read_text(encoding="utf-8").strip()
    api_key = os.environ.get("ARK_API_KEY", "").strip() or api_key

    model = str(config.get("model", "") or "").strip()
    model = os.environ.get("ARK_MODEL", "").strip() or model or ARK_MODEL

    configured_urls: list[str] = []
    base_value = config.get("base_url", "")
    if isinstance(base_value, list):
        configured_urls.extend(str(part).strip() for part in base_value if str(part).strip())
    elif isinstance(base_value, str) and base_value.strip():
        configured_urls.extend(part.strip() for part in base_value.replace(",", "\n").splitlines() if part.strip())
    legacy_base_path = ROOT / ".ark_base_url"
    if legacy_base_path.exists():
        raw = legacy_base_path.read_text(encoding="utf-8")
        configured_urls.extend(part.strip() for part in raw.replace(",", "\n").splitlines() if part.strip())
    env_value = os.environ.get("ARK_BASE_URL", "").strip()
    if env_value:
        configured_urls.extend(part.strip() for part in env_value.replace(",", "\n").splitlines() if part.strip())
    if not configured_urls:
        configured_urls.append(ARK_BASE_URL)

    deduped: list[str] = []
    for url in configured_urls:
        if url not in deduped:
            deduped.append(url)
    return {
        "api_key": api_key,
        "model": model,
        "base_urls": deduped,
    }


def normalize_ark_request_urls(base_url: str) -> list[str]:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/images/generations"):
        return [normalized]
    if normalized.endswith("/api/v3"):
        return [f"{normalized}/images/generations"]
    return [f"{normalized}/api/v3/images/generations"]


def guess_extension(mime: str) -> str:
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/svg+xml": ".svg",
        "video/mp4": ".mp4",
        "image/webp": ".webp",
    }.get(mime, ".bin")


def persist_data_url(data_url: str, directory: Path, stem: str) -> str:
    blob, mime = decode_data_url(data_url)
    ext = guess_extension(mime)
    path = directory / f"{stem}{ext}"
    path.write_bytes(blob)
    return f"/{path.relative_to(ROOT).as_posix()}"


def bbox_from_points(points: list[dict[str, float]], width: int, height: int) -> dict[str, float]:
    if not points:
        return {"x": width * 0.35, "y": height * 0.1, "width": width * 0.3, "height": height * 0.22}
    xs = [p["x"] for p in points]
    ys = [p["y"] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    padding = max(18.0, min(width, height) * 0.03)
    x = max(0.0, min_x - padding)
    y = max(0.0, min_y - padding)
    w = min(width - x, (max_x - min_x) + padding * 2)
    h = min(height - y, (max_y - min_y) + padding * 2)
    return {"x": x, "y": y, "width": w, "height": h}


def suggest_anchor(bbox: dict[str, float], width: int, height: int) -> str:
    center_x = bbox["x"] + bbox["width"] / 2
    center_y = bbox["y"] + bbox["height"] / 2
    norm_y = center_y / max(1, height)
    norm_x = center_x / max(1, width)
    if norm_y < 0.22:
        return "head_top"
    if norm_y < 0.36:
        if norm_x < 0.48:
            return "left_eye"
        if norm_x > 0.52:
            return "right_eye"
        return "face"
    if norm_y < 0.52:
        return "mouth"
    if norm_y < 0.68:
        return "neck"
    return "upper_body"


def generate_room_id() -> str:
    return uuid.uuid4().hex[:6].upper()


def color_from_points(points: list[dict[str, float]]) -> tuple[str, str]:
    if not points:
        return "#ff8ca8", "#ff4d73"
    seed = int(sum(p["x"] * 13 + p["y"] * 7 for p in points)) % 360
    accent = f"hsl({seed} 88% 62%)"
    glow = f"hsl({(seed + 24) % 360} 90% 70%)"
    return accent, glow


def svg_from_sketch(points: list[dict[str, float]], bbox: dict[str, float]) -> str:
    width = max(96, int(bbox["width"]))
    height = max(96, int(bbox["height"]))
    normalized = []
    for point in points:
        x = max(6, min(width - 6, point["x"] - bbox["x"]))
        y = max(6, min(height - 6, point["y"] - bbox["y"]))
        normalized.append((x, y))
    if len(normalized) < 2:
        normalized = [
            (width * 0.22, height * 0.72),
            (width * 0.36, height * 0.18),
            (width * 0.5, height * 0.64),
            (width * 0.64, height * 0.18),
            (width * 0.78, height * 0.72),
        ]
    accent, glow = color_from_points(points)
    polyline = " ".join(f"{round(x, 1)},{round(y, 1)}" for x, y in normalized)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <defs>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <linearGradient id="fill" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{accent}"/>
      <stop offset="100%" stop-color="{glow}"/>
    </linearGradient>
  </defs>
  <rect width="{width}" height="{height}" rx="24" fill="transparent"/>
  <polyline points="{polyline}" fill="none" stroke="url(#fill)" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
  <polyline points="{polyline}" fill="none" stroke="#ffffff" stroke-opacity="0.8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>"""


def generate_sticker_asset(canvas: CanvasContext, sketch_points: list[dict[str, float]]) -> dict[str, Any]:
    bbox = bbox_from_points(sketch_points, canvas.width, canvas.height)
    anchor = suggest_anchor(bbox, canvas.width, canvas.height)
    svg = svg_from_sketch(sketch_points, bbox)
    svg_b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    data_url = f"data:image/svg+xml;base64,{svg_b64}"
    return {
        "fixed_prompt": FIXED_PROMPT_TEMPLATE,
        "image_data_url": data_url,
        "bounding_box": bbox,
        "recommended_anchor": anchor,
        "category": "generated-sketch-sticker",
        "tags": ["sketch-driven", "tapshow", anchor],
    }


def call_ark_image_generation(source_images: str | list[str], target_count: int = 3) -> dict[str, Any]:
    model_config = load_model_config()
    api_key = model_config["api_key"]
    if not api_key:
        raise RuntimeError("ARK_API_KEY is not configured")

    model = model_config["model"]
    base_urls = model_config["base_urls"]
    source_list = source_images if isinstance(source_images, list) else [source_images]
    ark_images: list[str] = []
    for source_image in source_list:
        if source_image.startswith("data:image/"):
            ark_images.append(source_image)
        elif source_image.startswith("http"):
            ark_images.append(source_image)

    normalized_images: list[str] = []
    last_data: dict[str, Any] | None = None
    errors_seen: list[str] = []

    for base_url in base_urls:
        for request_url in normalize_ark_request_urls(base_url):
            payload: dict[str, Any] = {
                "model": model,
                "prompt": FIXED_PROMPT_TEMPLATE,
                "sequential_image_generation_options": {"max_images": max(1, target_count)},
                "sequential_image_generation": "auto",
                                "response_format": "b64_json",
                "size": "2K",
                "stream": False,
                "watermark": True,
            }
            if ark_images:
                payload["image"] = ark_images if len(ark_images) > 1 else ark_images[0]

            req = request.Request(
                request_url,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                method="POST",
            )
            try:
                with request.urlopen(req, timeout=180) as response:
                    data = json.loads(response.read().decode("utf-8"))
            except error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="ignore")
                errors_seen.append(f"{request_url} -> {exc.code} {detail}")
                continue
            except error.URLError as exc:
                errors_seen.append(f"{request_url} -> {exc.reason}")
                continue

            last_data = data
            for item in data.get("data", []):
                image_b64 = item.get("b64_json")
                image_url = item.get("url")
                if image_b64:
                    normalized = normalize_b64_image(image_b64)
                elif image_url:
                    normalized = image_url
                else:
                    continue
                if normalized not in normalized_images:
                    normalized_images.append(normalized)
                if len(normalized_images) >= target_count:
                    break
            if normalized_images:
                break
        if normalized_images:
            break

    if not normalized_images:
        detail = " | ".join(errors_seen[-4:]) if errors_seen else "No image returned"
        raise RuntimeError(f"ARK response did not contain any generated image. {detail}")
    return {
        "model": model,
        "image_data_url": normalized_images[0],
        "image_data_urls": normalized_images,
        "raw_response": last_data,
    }


def postprocess_sticker(sticker: dict[str, Any]) -> dict[str, Any]:
    bbox = sticker["bounding_box"]
    width = max(96, int(bbox["width"]))
    height = max(96, int(bbox["height"]))
    source_urls = sticker.get("image_data_urls") or [sticker["image_data_url"]]
    processed_urls: list[str] = []
    for source_url in source_urls:
        try:
            processed_urls.append(remove_background_from_data_url(source_url))
        except Exception:
            processed_urls.append(source_url)
    return {
        **sticker,
        "image_data_url": processed_urls[0],
        "image_data_urls": processed_urls,
        "width": width,
        "height": height,
        "content_type": "image/png",
        "mount": {
            "anchor": sticker["recommended_anchor"],
            "fallback_mode": "static",
            "offset_x": 0,
            "offset_y": 0,
            "scale": 1.0,
        },
    }


class TapShowHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        ensure_dirs()
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api_get(parsed)
            return
        if parsed.path.startswith("/data/"):
            return self.serve_local_file(ROOT / parsed.path.lstrip("/"))
        if parsed.path == "/" or parsed.path == "":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
            return
        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(payload.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.write_json({"error": "Invalid JSON payload"}, status=HTTPStatus.BAD_REQUEST)
            return
        self.handle_api_post(parsed.path, body)

    def handle_api_get(self, parsed: Any) -> None:
        if parsed.path == "/api/templates/discover":
            self.write_json({"templates": DISCOVER_TEMPLATES})
            return
        if parsed.path == "/api/templates/mine":
            self.write_json({"templates": read_json(TEMPLATES_FILE)})
            return
        if parsed.path == "/api/assets/mine":
            self.write_json({"assets": read_json(ASSETS_FILE)})
            return
        if parsed.path == "/api/canvas":
            query = parse_qs(parsed.query)
            canvas_id = query.get("id", [""])[0]
            canvas = next((c for c in read_json(CANVAS_FILE) if c["id"] == canvas_id), None)
            if not canvas:
                self.write_json({"error": "Canvas not found"}, status=HTTPStatus.NOT_FOUND)
                return
            self.write_json({"canvas": canvas})
            return
        if parsed.path == "/api/room/poll":
            self.api_room_poll(parsed)
            return
        if parsed.path == "/api/room/frame/latest":
            self.api_room_frame_latest(parsed)
            return
        self.write_json({"error": "Unknown endpoint"}, status=HTTPStatus.NOT_FOUND)

    def handle_api_post(self, path: str, body: dict[str, Any]) -> None:
        if path == "/api/canvas/init":
            self.api_canvas_init(body)
            return
        if path == "/api/canvas/sketch":
            self.api_canvas_sketch(body)
            return
        if path == "/api/stickers/generate":
            self.api_sticker_generate(body)
            return
        if path == "/api/stickers/postprocess":
            self.api_sticker_postprocess(body)
            return
        if path == "/api/assets/save-sticker":
            self.api_save_sticker(body)
            return
        if path == "/api/templates/save":
            self.api_save_template(body)
            return
        if path == "/api/captures/save":
            self.api_save_capture(body)
            return
        if path == "/api/room/create":
            self.api_room_create(body)
            return
        if path == "/api/room/join":
            self.api_room_join(body)
            return
        if path == "/api/room/heartbeat":
            self.api_room_heartbeat(body)
            return
        if path == "/api/room/frame/upload":
            self.api_room_frame_upload(body)
            return
        if path == "/api/room/sticker/send":
            self.api_room_sticker_send(body)
            return
        if path == "/api/room/signal":
            self.api_room_signal(body)
            return
        self.write_json({"error": "Unknown endpoint"}, status=HTTPStatus.NOT_FOUND)

    def api_canvas_init(self, body: dict[str, Any]) -> None:
        image_data_url = body.get("imageDataUrl")
        width = int(body.get("width", 0))
        height = int(body.get("height", 0))
        if not image_data_url or width <= 0 or height <= 0:
            self.write_json({"error": "imageDataUrl, width and height are required"}, status=HTTPStatus.BAD_REQUEST)
            return
        canvas = CanvasContext(
            id=f"canvas-{uuid.uuid4().hex[:12]}",
            image_data_url=image_data_url,
            width=width,
            height=height,
            created_at=utc_now(),
            sketch_points=[],
        )
        with LOCK:
            items = read_json(CANVAS_FILE)
            items.append(asdict(canvas))
            write_json(CANVAS_FILE, items)
        self.write_json({"canvas": asdict(canvas)})

    def api_canvas_sketch(self, body: dict[str, Any]) -> None:
        canvas_id = body.get("canvasId")
        points = body.get("points", [])
        if not canvas_id:
            self.write_json({"error": "canvasId is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        with LOCK:
            items = read_json(CANVAS_FILE)
            for item in items:
                if item["id"] == canvas_id:
                    item["sketch_points"] = points
                    item["updated_at"] = utc_now()
                    write_json(CANVAS_FILE, items)
                    self.write_json({"canvas": item})
                    return
        self.write_json({"error": "Canvas not found"}, status=HTTPStatus.NOT_FOUND)

    def api_sticker_generate(self, body: dict[str, Any]) -> None:
        canvas_id = body.get("canvasId")
        source_images = body.get("sourceImages")
        if not canvas_id and not source_images:
            self.write_json({"error": "canvasId or sourceImages is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        canvas = next((c for c in read_json(CANVAS_FILE) if c["id"] == canvas_id), None) if canvas_id else None
        if canvas_id and not canvas:
            self.write_json({"error": "Canvas not found"}, status=HTTPStatus.NOT_FOUND)
            return

        if canvas:
            fallback_asset = generate_sticker_asset(
                CanvasContext(**{k: canvas[k] for k in ["id", "image_data_url", "width", "height", "created_at", "sketch_points"]}),
                canvas.get("sketch_points", []),
            )
        else:
            fallback_asset = {
                "id": f"sticker-{uuid.uuid4().hex[:10]}",
                "image_data_url": "",
                "image_data_urls": [],
                "width": 1024,
                "height": 1024,
                "recommended_anchor": "face",
                "mount": {"scale": 1.0, "offset_x": 0, "offset_y": 0},
                "bounding_box": {"x": 0.25, "y": 0.15, "width": 0.5, "height": 0.5},
                "tags": ["remote", "sticker"],
            }
        if source_images:
            try:
                model_result = call_ark_image_generation(source_images)
                fallback_asset["image_data_url"] = model_result["image_data_url"]
                fallback_asset["image_data_urls"] = model_result.get("image_data_urls", [model_result["image_data_url"]])
                fallback_asset["provider"] = "ark"
                fallback_asset["model"] = model_result["model"]
            except RuntimeError as exc:
                fallback_asset["provider"] = "mock-fallback"
                fallback_asset["generation_error"] = str(exc)
        else:
            fallback_asset["provider"] = "mock"
            fallback_asset["image_data_urls"] = [fallback_asset["image_data_url"]]
        self.write_json({"sticker": fallback_asset})

    def api_sticker_postprocess(self, body: dict[str, Any]) -> None:
        sticker = body.get("sticker")
        if not sticker:
            self.write_json({"error": "sticker is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        self.write_json({"sticker": postprocess_sticker(sticker)})

    def api_save_sticker(self, body: dict[str, Any]) -> None:
        sticker = body.get("sticker")
        canvas_id = body.get("canvasId")
        if not sticker or not canvas_id:
            self.write_json({"error": "sticker and canvasId are required"}, status=HTTPStatus.BAD_REQUEST)
            return
        sticker_id = f"sticker-{uuid.uuid4().hex[:12]}"
        saved_path = persist_data_url(sticker["image_data_url"], STICKERS_DIR, sticker_id)
        record = {
            "id": sticker_id,
            "kind": "sticker",
            "canvas_id": canvas_id,
            "image_url": saved_path,
            "recommended_anchor": sticker.get("recommended_anchor"),
            "mount": sticker.get("mount", {}),
            "bounding_box": sticker.get("bounding_box"),
            "tags": sticker.get("tags", []),
            "created_at": utc_now(),
        }
        with LOCK:
            assets = read_json(ASSETS_FILE)
            assets.append(record)
            write_json(ASSETS_FILE, assets)
        self.write_json({"asset": record})

    def api_save_template(self, body: dict[str, Any]) -> None:
        sticker = body.get("sticker")
        name = body.get("name") or "未命名模板"
        if not sticker:
            self.write_json({"error": "sticker is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        template_id = f"template-{uuid.uuid4().hex[:12]}"
        preview_path = persist_data_url(sticker["image_data_url"], STICKERS_DIR, template_id)
        record = {
            "id": template_id,
            "name": name,
            "kind": "template",
            "preview_url": preview_path,
            "anchor": sticker.get("recommended_anchor"),
            "mount": sticker.get("mount", {}),
            "created_at": utc_now(),
            "source": {"fixed_prompt": FIXED_PROMPT_TEMPLATE, "tags": sticker.get("tags", [])},
        }
        with LOCK:
            items = read_json(TEMPLATES_FILE)
            items.append(record)
            write_json(TEMPLATES_FILE, items)
        self.write_json({"template": record})

    def api_save_capture(self, body: dict[str, Any]) -> None:
        capture_data_url = body.get("captureDataUrl")
        capture_type = body.get("captureType", "image")
        if not capture_data_url:
            self.write_json({"error": "captureDataUrl is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        capture_id = f"capture-{uuid.uuid4().hex[:12]}"
        saved_path = persist_data_url(capture_data_url, CAPTURES_DIR, capture_id)
        record = {"id": capture_id, "kind": "capture", "capture_type": capture_type, "url": saved_path, "created_at": utc_now()}
        with LOCK:
            assets = read_json(ASSETS_FILE)
            assets.append(record)
            write_json(ASSETS_FILE, assets)
        self.write_json({"asset": record})

    def api_room_create(self, body: dict[str, Any]) -> None:
        display_name = (body.get("displayName") or "房主").strip()
        room = {
            "id": f"room-{generate_room_id()}",
            "host_user_id": f"user-{uuid.uuid4().hex[:8]}",
            "host_name": display_name,
            "guest_user_id": None,
            "guest_name": None,
            "created_at": utc_now(),
            "updated_at": utc_now(),
            "latest_frames": {},
            "signals": [],
            "sticker_messages": [],
        }
        with LOCK:
            rooms = read_json(ROOMS_FILE)
            rooms.append(room)
            write_json(ROOMS_FILE, rooms)
        self.write_json({"room": room, "userId": room["host_user_id"], "role": "host"})

    def api_room_join(self, body: dict[str, Any]) -> None:
        room_id = body.get("roomId")
        display_name = (body.get("displayName") or "加入者").strip()
        if not room_id:
            self.write_json({"error": "roomId is required"}, status=HTTPStatus.BAD_REQUEST)
            return
        with LOCK:
            rooms = read_json(ROOMS_FILE)
            for room in rooms:
                if room["id"] != room_id:
                    continue
                if room.get("guest_user_id") and room.get("guest_name") != display_name:
                    self.write_json({"error": "Room is full"}, status=HTTPStatus.CONFLICT)
                    return
                if not room.get("guest_user_id"):
                    room["guest_user_id"] = f"user-{uuid.uuid4().hex[:8]}"
                room["guest_name"] = display_name
                room["updated_at"] = utc_now()
                write_json(ROOMS_FILE, rooms)
                self.write_json({"room": room, "userId": room["guest_user_id"], "role": "guest"})
                return
        self.write_json({"error": "Room not found"}, status=HTTPStatus.NOT_FOUND)

    def api_room_heartbeat(self, body: dict[str, Any]) -> None:
        room_id = body.get("roomId")
        user_id = body.get("userId")
        if not room_id or not user_id:
            self.write_json({"error": "roomId and userId are required"}, status=HTTPStatus.BAD_REQUEST)
            return
        with LOCK:
            rooms = read_json(ROOMS_FILE)
            for room in rooms:
                if room["id"] == room_id:
                    room["updated_at"] = utc_now()
                    write_json(ROOMS_FILE, rooms)
                    self.write_json({"ok": True, "room": room})
                    return
        self.write_json({"error": "Room not found"}, status=HTTPStatus.NOT_FOUND)

    def api_room_frame_upload(self, body: dict[str, Any]) -> None:
        room_id = body.get("roomId")
        user_id = body.get("userId")
        image_data_url = body.get("imageDataUrl")
        width = int(body.get("width", 0))
        height = int(body.get("height", 0))
        if not room_id or not user_id or not image_data_url or width <= 0 or height <= 0:
            self.write_json({"error": "roomId, userId, imageDataUrl, width and height are required"}, status=HTTPStatus.BAD_REQUEST)
            return
        frame = {
            "frameId": f"frame-{uuid.uuid4().hex[:10]}",
            "userId": user_id,
            "imageDataUrl": image_data_url,
            "width": width,
            "height": height,
            "created_at": utc_now(),
        }
        with LOCK:
            rooms = read_json(ROOMS_FILE)
            for room in rooms:
                if room["id"] == room_id:
                    room.setdefault("latest_frames", {})[user_id] = frame
                    room["updated_at"] = utc_now()
                    write_json(ROOMS_FILE, rooms)
                    self.write_json({"frame": frame})
                    return
        self.write_json({"error": "Room not found"}, status=HTTPStatus.NOT_FOUND)

    def api_room_poll(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        room_id = query.get("roomId", [""])[0]
        user_id = query.get("userId", [""])[0]
        if not room_id or not user_id:
            self.write_json({"error": "roomId and userId are required"}, status=HTTPStatus.BAD_REQUEST)
            return
        room = next((r for r in read_json(ROOMS_FILE) if r["id"] == room_id), None)
        if not room:
            self.write_json({"error": "Room not found"}, status=HTTPStatus.NOT_FOUND)
            return
        latest_frames = room.get("latest_frames", {})
        remote_user_id = room.get("guest_user_id") if room.get("host_user_id") == user_id else room.get("host_user_id")
        incoming_signals = [signal for signal in room.get("signals", []) if signal.get("toUserId") == user_id]
        incoming_stickers = [item for item in room.get("sticker_messages", []) if item.get("toUserId") == user_id]
        if incoming_signals:
            with LOCK:
                rooms = read_json(ROOMS_FILE)
                for room_item in rooms:
                    if room_item["id"] == room_id:
                        room_item["signals"] = [signal for signal in room_item.get("signals", []) if signal.get("toUserId") != user_id]
                        if incoming_stickers:
                            room_item["sticker_messages"] = [
                                item for item in room_item.get("sticker_messages", []) if item.get("toUserId") != user_id
                            ]
                        write_json(ROOMS_FILE, rooms)
                        break
        elif incoming_stickers:
            with LOCK:
                rooms = read_json(ROOMS_FILE)
                for room_item in rooms:
                    if room_item["id"] == room_id:
                        room_item["sticker_messages"] = [
                            item for item in room_item.get("sticker_messages", []) if item.get("toUserId") != user_id
                        ]
                        write_json(ROOMS_FILE, rooms)
                        break
        self.write_json({
            "room": room,
            "remoteUserId": remote_user_id,
            "remoteFrame": latest_frames.get(remote_user_id),
            "localFrame": latest_frames.get(user_id),
            "signals": incoming_signals,
            "incomingStickers": incoming_stickers,
        })

    def api_room_frame_latest(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        room_id = query.get("roomId", [""])[0]
        target_user_id = query.get("targetUserId", [""])[0]
        if not room_id or not target_user_id:
            self.write_json({"error": "roomId and targetUserId are required"}, status=HTTPStatus.BAD_REQUEST)
            return
        room = next((r for r in read_json(ROOMS_FILE) if r["id"] == room_id), None)
        if not room:
            self.write_json({"error": "Room not found"}, status=HTTPStatus.NOT_FOUND)
            return
        frame = room.get("latest_frames", {}).get(target_user_id)
        if not frame:
            self.write_json({"error": "Frame not found"}, status=HTTPStatus.NOT_FOUND)
            return
        self.write_json({"frame": frame})

    def api_room_signal(self, body: dict[str, Any]) -> None:
        room_id = body.get("roomId")
        from_user_id = body.get("fromUserId")
        to_user_id = body.get("toUserId")
        signal_type = body.get("type")
        payload = body.get("payload")
        if not room_id or not from_user_id or not to_user_id or not signal_type:
            self.write_json({"error": "roomId, fromUserId, toUserId and type are required"}, status=HTTPStatus.BAD_REQUEST)
            return
        signal = {
            "id": f"signal-{uuid.uuid4().hex[:10]}",
            "fromUserId": from_user_id,
            "toUserId": to_user_id,
            "type": signal_type,
            "payload": payload,
            "created_at": utc_now(),
        }
        with LOCK:
            rooms = read_json(ROOMS_FILE)
            for room in rooms:
                if room["id"] == room_id:
                    room.setdefault("signals", []).append(signal)
                    room["updated_at"] = utc_now()
                    write_json(ROOMS_FILE, rooms)
                    self.write_json({"signal": signal})
                    return
        self.write_json({"error": "Room not found"}, status=HTTPStatus.NOT_FOUND)

    def api_room_sticker_send(self, body: dict[str, Any]) -> None:
        room_id = body.get("roomId")
        from_user_id = body.get("fromUserId")
        to_user_id = body.get("toUserId")
        sticker = body.get("sticker")
        binding = body.get("binding")
        initial_face_result = body.get("initialFaceResult")
        if not room_id or not from_user_id or not to_user_id or not sticker or not binding or not initial_face_result:
            self.write_json(
                {"error": "roomId, fromUserId, toUserId, sticker, binding and initialFaceResult are required"},
                status=HTTPStatus.BAD_REQUEST,
            )
            return
        message = {
            "id": f"sticker-{uuid.uuid4().hex[:10]}",
            "fromUserId": from_user_id,
            "toUserId": to_user_id,
            "sticker": sticker,
            "binding": binding,
            "initialFaceResult": initial_face_result,
            "created_at": utc_now(),
        }
        with LOCK:
            rooms = read_json(ROOMS_FILE)
            for room in rooms:
                if room["id"] == room_id:
                    room.setdefault("sticker_messages", []).append(message)
                    room["updated_at"] = utc_now()
                    write_json(ROOMS_FILE, rooms)
                    self.write_json({"message": message})
                    return
        self.write_json({"error": "Room not found"}, status=HTTPStatus.NOT_FOUND)

    def write_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def serve_local_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        content = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(content)


def run_server(host: str = "0.0.0.0", port: int = 8000, https_port: int = 8443) -> None:
    ensure_dirs()

    http_server = ThreadingHTTPServer((host, port), TapShowHandler)

    servers: list[tuple[str, ThreadingHTTPServer]] = [("http", http_server)]

    if HTTPS_CERT_FILE.exists() and HTTPS_KEY_FILE.exists():
        https_server = ThreadingHTTPServer((host, https_port), TapShowHandler)
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(certfile=str(HTTPS_CERT_FILE), keyfile=str(HTTPS_KEY_FILE))
        https_server.socket = ssl_context.wrap_socket(https_server.socket, server_side=True)
        servers.append(("https", https_server))

    for scheme, server in servers[1:]:
        thread = threading.Thread(target=server.serve_forever, daemon=True, name=f"tapshow-{scheme}")
        thread.start()

    print(f"TapShow MVP server running at http://{host}:{port}")
    if len(servers) > 1:
        print(f"TapShow MVP server running at https://{host}:{https_port}")

    http_server.serve_forever()


if __name__ == "__main__":
    run_server()


