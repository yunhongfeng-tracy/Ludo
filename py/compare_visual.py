#!/usr/bin/env python3
"""比较 1536x1024 效果稿与浏览器截图，并生成差异热图和 JSON 指标。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


REGIONS = {
    "whole": (0, 0, 1536, 1024),
    "header": (0, 0, 1536, 85),
    "board": (91, 85, 954, 943),
    "panel": (968, 85, 1442, 967),
    "footer": (0, 943, 968, 1024),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="目标效果稿 PNG")
    parser.add_argument("actual", type=Path, help="浏览器实际截图 PNG")
    parser.add_argument("--diff", type=Path, required=True, help="差异热图输出路径")
    parser.add_argument("--json", type=Path, required=True, help="指标 JSON 输出路径")
    return parser.parse_args()


def region_metrics(target: np.ndarray, actual: np.ndarray, box: tuple[int, int, int, int]) -> dict[str, float]:
    left, top, right, bottom = box
    difference = np.abs(target[top:bottom, left:right] - actual[top:bottom, left:right])
    pixel_max = difference.max(axis=2)
    return {
        "meanAbsoluteError": round(float(difference.mean()), 4),
        "rootMeanSquareError": round(float(np.sqrt(np.square(difference).mean())), 4),
        "exactPixelPercent": round(float((pixel_max == 0).mean() * 100), 4),
        "within2PixelPercent": round(float((pixel_max <= 2).mean() * 100), 4),
        "within8PixelPercent": round(float((pixel_max <= 8).mean() * 100), 4),
        "maximumChannelDifference": int(difference.max()),
    }


def main() -> int:
    args = parse_args()
    with Image.open(args.target) as target_image, Image.open(args.actual) as actual_image:
        target_rgb = target_image.convert("RGB")
        actual_rgb = actual_image.convert("RGB")
        if target_rgb.size != actual_rgb.size:
            raise ValueError(f"图片尺寸不一致：目标 {target_rgb.size}，实际 {actual_rgb.size}")
        if target_rgb.size != (1536, 1024):
            raise ValueError(f"视觉基准必须为 1536x1024，实际为 {target_rgb.size}")
        target = np.asarray(target_rgb, dtype=np.int16)
        actual = np.asarray(actual_rgb, dtype=np.int16)

    metrics = {
        "target": str(args.target),
        "actual": str(args.actual),
        "size": {"width": 1536, "height": 1024},
        "regions": {name: region_metrics(target, actual, box) for name, box in REGIONS.items()},
    }
    absolute = np.abs(target - actual).astype(np.uint8)
    heat = np.clip(absolute.astype(np.int16) * 8, 0, 255).astype(np.uint8)
    heat[..., 1] = np.minimum(heat[..., 1], heat[..., 0] // 3)
    heat[..., 2] = np.minimum(heat[..., 2], heat[..., 0] // 4)

    args.diff.parent.mkdir(parents=True, exist_ok=True)
    args.json.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(heat).save(args.diff, "PNG", optimize=True)
    args.json.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if "\ufffd" in args.json.read_text(encoding="utf-8"):
        raise ValueError("指标 JSON 存在 Unicode 替换字符 U+FFFD")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
