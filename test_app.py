import base64
import tempfile
import unittest
from pathlib import Path

import app
from bg_remove import remove_background_from_data_url
from PIL import Image


class TapShowHelpersTest(unittest.TestCase):
    def test_bbox_defaults_without_points(self):
        bbox = app.bbox_from_points([], 1000, 800)
        self.assertGreater(bbox["width"], 0)
        self.assertGreater(bbox["height"], 0)

    def test_generate_sticker_asset_uses_fixed_prompt(self):
        canvas = app.CanvasContext(
            id="canvas-1",
            image_data_url="data:image/png;base64,AAA=",
            width=1000,
            height=800,
            created_at="now",
            sketch_points=[],
        )
        sticker = app.generate_sticker_asset(canvas, [{"x": 120, "y": 80}, {"x": 190, "y": 130}])
        self.assertEqual(sticker["fixed_prompt"], app.FIXED_PROMPT_TEMPLATE)
        self.assertTrue(sticker["image_data_url"].startswith("data:image/svg+xml;base64,"))

    def test_postprocess_adds_mount(self):
        processed = app.postprocess_sticker(
            {
                "image_data_url": "data:image/svg+xml;base64,AAA=",
                "bounding_box": {"x": 0, "y": 0, "width": 120, "height": 80},
                "recommended_anchor": "head_top",
                "tags": [],
            }
        )
        self.assertEqual(processed["mount"]["anchor"], "head_top")
        self.assertEqual(processed["content_type"], "image/png")

    def test_json_roundtrip(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "items.json"
            payload = [{"id": "a"}]
            app.write_json(path, payload)
            self.assertEqual(app.read_json(path), payload)

    def test_normalize_b64_image(self):
        value = app.normalize_b64_image("Zm9v")
        self.assertTrue(value.startswith("data:image/png;base64,"))

    def test_remove_background_from_data_url(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "sample.png"
            image = Image.new("RGBA", (4, 4), (255, 255, 255, 255))
            image.putpixel((1, 1), (255, 0, 0, 255))
            image.save(path)
            sample = app.normalize_b64_image(base64.b64encode(path.read_bytes()).decode("ascii"))
        result = remove_background_from_data_url(sample)
        self.assertTrue(result.startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
