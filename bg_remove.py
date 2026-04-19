import base64
import io
from collections import deque

from PIL import Image


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    header, encoded = data_url.split(",", 1)
    mime = header.split(";")[0].replace("data:", "", 1)
    return base64.b64decode(encoded), mime


def _encode_png_data_url(blob: bytes) -> str:
    return f"data:image/png;base64,{base64.b64encode(blob).decode('ascii')}"


def _color_distance(pixel: tuple[int, int, int, int], target: tuple[int, int, int]) -> int:
    r, g, b, _ = pixel
    tr, tg, tb = target
    return abs(r - tr) + abs(g - tg) + abs(b - tb)


def _is_background_like(pixel: tuple[int, int, int, int], targets: list[tuple[int, int, int]], threshold: int) -> bool:
    if pixel[3] == 0:
        return True
    return any(_color_distance(pixel, target) <= threshold for target in targets)


def _border_reference_colors(image: Image.Image) -> list[tuple[int, int, int]]:
    width, height = image.size
    samples: list[tuple[int, int, int]] = []
    rgba = image.load()
    for x in range(width):
        for y in (0, height - 1):
            r, g, b, a = rgba[x, y]
            if a > 0:
                samples.append((r, g, b))
    for y in range(height):
        for x in (0, width - 1):
            r, g, b, a = rgba[x, y]
            if a > 0:
                samples.append((r, g, b))
    if not samples:
        return [(255, 255, 255), (0, 0, 0)]

    bright = [sample for sample in samples if max(sample) > 200]
    dark = [sample for sample in samples if max(sample) < 50]
    refs: list[tuple[int, int, int]] = []
    if bright:
        refs.append(tuple(int(sum(channel) / len(bright)) for channel in zip(*bright)))
    if dark:
        refs.append(tuple(int(sum(channel) / len(dark)) for channel in zip(*dark)))
    if not refs:
        refs.append(tuple(int(sum(channel) / len(samples)) for channel in zip(*samples)))
    return refs


def _flood_remove_background(image: Image.Image, threshold: int = 42) -> Image.Image:
    image = image.convert("RGBA")
    width, height = image.size
    pixels = image.load()
    visited = [[False for _ in range(height)] for _ in range(width)]
    queue: deque[tuple[int, int]] = deque()
    refs = _border_reference_colors(image)

    def push(x: int, y: int) -> None:
        if 0 <= x < width and 0 <= y < height and not visited[x][y]:
            visited[x][y] = True
            queue.append((x, y))

    for x in range(width):
        push(x, 0)
        push(x, height - 1)
    for y in range(height):
        push(0, y)
        push(width - 1, y)

    while queue:
        x, y = queue.popleft()
        pixel = pixels[x, y]
        if not _is_background_like(pixel, refs, threshold):
            continue
        pixels[x, y] = (pixel[0], pixel[1], pixel[2], 0)
        push(x - 1, y)
        push(x + 1, y)
        push(x, y - 1)
        push(x, y + 1)

    return image


def remove_background_from_data_url(data_url: str) -> str:
    blob, _ = _decode_data_url(data_url)
    image = Image.open(io.BytesIO(blob))
    image = _flood_remove_background(image)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return _encode_png_data_url(output.getvalue())
