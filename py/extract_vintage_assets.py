#!/usr/bin/env python3
"""从复古 Ludo 视觉稿中确定性裁切首批可复用 PNG 资产。"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "doc" / "design" / "ludo-vintage-target.png"
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "src" / "assets" / "vintage"
DEFAULT_CLEAN_PLATE = (
    Path.home()
    / ".codex"
    / "generated_images"
    / "01a07af3-dc35-7a70-80e2-887e76281450"
    / "exec-32303a2b-67de-4b17-8fb5-242187e0fada.png"
)
EXPECTED_CANVAS_SIZE = (1536, 1024)


# 坐标使用 Pillow 约定的左闭右开 (left, top, right, bottom)。
# 这些切片全部来自同一张 1536x1024 定稿图，方便前端按原始像素校准。
CROP_SPECS: tuple[dict[str, Any], ...] = (
    {
        "id": "wood_texture_horizontal",
        "filename": "wood-texture-horizontal.png",
        "box": (488, 0, 1150, 84),
        "purpose": "页头下方无文字的横向木桌纹理样本，可用于背景取色和横向纹理拼接。",
        "limitations": "高度只有 84px；直接纵向拉伸会放大木纹，应优先 repeat 或与纵向样本混合。",
    },
    {
        "id": "wood_texture_vertical",
        "filename": "wood-texture-vertical.png",
        "box": (0, 86, 72, 960),
        "purpose": "左侧无 UI 的纵向木桌纹理样本，可用于页面长边背景取色。",
        "limitations": "宽度只有 72px，右缘含棋盘自然投影，适合保留目标图的空间关系。",
    },
    {
        "id": "header_brand",
        "filename": "header-brand.png",
        "box": (95, 15, 485, 72),
        "purpose": "四色圆点、LUDO 字标、竖线与中文副标题的完整页头样本。",
        "limitations": "文字和木纹底色已烘焙，不适合无损缩放或动态改字。",
    },
    {
        "id": "board_complete",
        "filename": "board-complete.png",
        "box": (91, 85, 954, 943),
        "purpose": "带木框、折痕、棋盘格和当前棋子状态的完整棋盘区域。",
        "limitations": "红黄棋子已烘焙；动态游戏应优先使用 clean plate，再叠加棋子。",
    },
    {
        "id": "right_score_panel",
        "filename": "right-score-panel.png",
        "box": (968, 85, 1442, 967),
        "purpose": "右侧完整旧纸记分面板，包括纸张边框、按钮、文字和骰盅。",
        "limitations": "分数、难度、状态文字与骰子结果已烘焙；适合作为像素对照，不宜直接承担交互。",
    },
    {
        "id": "dice_cup_region",
        "filename": "dice-cup-region.png",
        "box": (1244, 374, 1417, 536),
        "purpose": "带木框、绿色绒布、阴影和骰子的完整骰盅区域样本。",
        "limitations": "骰子点数和纸面底色已烘焙。",
    },
    {
        "id": "dice_face_five",
        "filename": "dice-face-five.png",
        "box": (1293, 426, 1364, 500),
        "purpose": "五点骰子近景样本，包含圆角、立体高光和投影。",
        "limitations": "绿色绒布背景和投影已烘焙，不是透明精灵。",
    },
    {
        "id": "red_token_selected",
        "filename": "red-token-selected-sample.png",
        "box": (205, 656, 277, 733),
        "purpose": "红色 1 号棋子的选中态样本，含白黑双环和投影。",
        "limitations": "红色棋盘底色已烘焙，不是透明精灵。",
    },
    {
        "id": "red_token_default",
        "filename": "red-token-default-sample.png",
        "box": (298, 663, 365, 731),
        "purpose": "红色 2 号棋子的普通态样本，含方形底座和投影。",
        "limitations": "红色棋盘底色与数字 2 已烘焙，不是通用透明棋子。",
    },
    {
        "id": "yellow_token_one",
        "filename": "yellow-token-one-sample.png",
        "box": (689, 193, 756, 258),
        "purpose": "黄色 1 号棋子样本，含方形底座、金属高光和投影。",
        "limitations": "浅色基地底色与数字 1 已烘焙，不是通用透明棋子。",
    },
    {
        "id": "yellow_token_two",
        "filename": "yellow-token-two-sample.png",
        "box": (779, 193, 846, 258),
        "purpose": "黄色 2 号棋子样本，用于核对普通态大小和间距。",
        "limitations": "浅色基地底色与数字 2 已烘焙，不是通用透明棋子。",
    },
)


CLEAN_PLATE_CROP_SPECS: tuple[dict[str, Any], ...] = (
    {
        "id": "board_cleanplate",
        "filename": "board-cleanplate.png",
        "box": (91, 85, 954, 943),
        "purpose": "移除所有棋子后的完整棋盘，可作为动态棋子的静态底层。",
        "limitations": "棋盘中的 HOME、箭头与星形仍为底图内容。",
    },
    {
        "id": "right_score_panel_cleanplate",
        "filename": "right-score-panel-cleanplate.png",
        "box": (968, 85, 1442, 967),
        "purpose": "骰盅为空的右侧纸质面板，可在骰盅上叠加动态骰子。",
        "limitations": "面板文字、按钮、分数与难度状态仍为底图内容。",
    },
    {
        "id": "dice_cup_empty",
        "filename": "dice-cup-empty.png",
        "box": (1244, 374, 1417, 536),
        "purpose": "空骰盅样本，保留木框、绿色绒布、内阴影和纸面环境。",
        "limitations": "周围纸面底色已烘焙。",
    },
)


CUTOUT_SPECS: tuple[dict[str, Any], ...] = (
    {
        "id": "red_token_selected_cutout",
        "filename": "red-token-selected-cutout.png",
        "box": (205, 656, 277, 733),
        "purpose": "从目标图裁切并按轮廓抠出的红色选中态透明棋子。",
        "limitations": "透明边缘来自人工几何蒙版，保留圆环和方形底座，正式缩放前需复核暗边。",
        "shapes": (("rectangle", (10, 8, 63, 64), 0), ("ellipse", (2, 2, 71, 76), 0)),
    },
    {
        "id": "red_token_default_cutout",
        "filename": "red-token-default-cutout.png",
        "box": (298, 663, 365, 731),
        "purpose": "从目标图裁切并按轮廓抠出的红色普通态透明棋子。",
        "limitations": "保留方形底座、投影和数字 2；透明边缘来自人工几何蒙版。",
        "shapes": (("rounded_rectangle", (2, 2, 66, 65), 3),),
    },
    {
        "id": "yellow_token_one_cutout",
        "filename": "yellow-token-one-cutout.png",
        "box": (689, 193, 756, 258),
        "purpose": "从目标图裁切并按轮廓抠出的黄色普通态透明棋子。",
        "limitations": "保留方形底座、投影和数字 1；透明边缘来自人工几何蒙版。",
        "shapes": (("rounded_rectangle", (2, 2, 66, 64), 3),),
    },
    {
        "id": "yellow_token_two_cutout",
        "filename": "yellow-token-two-cutout.png",
        "box": (779, 193, 846, 258),
        "purpose": "从目标图裁切并按轮廓抠出的黄色普通态透明棋子。",
        "limitations": "保留方形底座、投影和数字 2；透明边缘来自人工几何蒙版。",
        "shapes": (("rounded_rectangle", (2, 2, 66, 64), 3),),
    },
    {
        "id": "dice_face_five_cutout",
        "filename": "dice-face-five-cutout.png",
        "box": (1293, 426, 1364, 500),
        "purpose": "从目标图裁切并按轮廓抠出的五点骰子透明图。",
        "limitations": "保留骰子自然投影；透明边缘来自人工几何蒙版，其他点数仍需单独制作。",
        "shapes": (("rounded_rectangle", (3, 8, 68, 72), 13),),
    },
)


PAPER_TEXTURE_SPEC: dict[str, Any] = {
    "id": "paper_texture",
    "filename": "paper-texture.png",
    "box": (1090, 650, 1410, 682),
    "purpose": "从右侧面板无文字、无线条的空白区域制作的可平铺旧纸纹理。",
    "limitations": "采用源区域的 2x2 镜像拼接确保边缘闭合；纹理图案每 640x64px 重复一次。",
}


def sha256_file(path: Path) -> str:
    """计算文件 SHA-256，供 manifest 追踪源文件与输出。"""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_png(path: Path, expected_size: tuple[int, int] | None = None) -> dict[str, Any]:
    """同时执行 PNG 结构校验和完整像素解码。"""
    with Image.open(path) as image:
        if image.format != "PNG":
            raise ValueError(f"{path} 不是 PNG，实际格式为 {image.format}")
        image.verify()

    with Image.open(path) as image:
        image.load()
        size = image.size
        mode = image.mode

    if expected_size is not None and size != expected_size:
        raise ValueError(f"{path} 尺寸应为 {expected_size}，实际为 {size}")

    return {
        "width": size[0],
        "height": size[1],
        "mode": mode,
        "sha256": sha256_file(path),
    }


def validate_jpeg(path: Path, expected_size: tuple[int, int] | None = None) -> dict[str, Any]:
    """同时执行 JPEG 结构校验和完整像素解码。"""
    with Image.open(path) as image:
        if image.format != "JPEG":
            raise ValueError(f"{path} 不是 JPEG，实际格式为 {image.format}")
        image.verify()

    with Image.open(path) as image:
        image.load()
        size = image.size
        mode = image.mode

    if expected_size is not None and size != expected_size:
        raise ValueError(f"{path} 尺寸应为 {expected_size}，实际为 {size}")

    return {
        "width": size[0],
        "height": size[1],
        "mode": mode,
        "sha256": sha256_file(path),
    }


def portable_source_path(path: Path) -> str:
    """优先记录项目相对路径或用户目录相对路径，避免固化机器用户名。"""
    resolved = path.resolve()
    for base, prefix in ((PROJECT_ROOT.resolve(), ""), (Path.home().resolve(), "~/")):
        try:
            relative = resolved.relative_to(base)
            return prefix + relative.as_posix()
        except ValueError:
            continue
    return str(resolved)


def source_record(path: Path) -> dict[str, Any]:
    """生成不依赖运行时间的源文件记录。"""
    info = validate_png(path, EXPECTED_CANVAS_SIZE)
    return {
        "path": portable_source_path(path),
        "width": info["width"],
        "height": info["height"],
        "sha256": info["sha256"],
    }


def crop_assets(
    source: Path,
    output_dir: Path,
    specs: tuple[dict[str, Any], ...],
    source_key: str,
) -> list[dict[str, Any]]:
    """按固定坐标裁切，并立即重新打开验证。"""
    assets: list[dict[str, Any]] = []
    with Image.open(source) as source_image:
        source_image.load()
        for spec in specs:
            left, top, right, bottom = spec["box"]
            output_path = output_dir / spec["filename"]
            cropped = source_image.crop((left, top, right, bottom))
            cropped.save(output_path, format="PNG", optimize=True)

            expected_size = (right - left, bottom - top)
            info = validate_png(output_path, expected_size)
            assets.append(
                {
                    "id": spec["id"],
                    "file": spec["filename"],
                    "process": "crop",
                    "source": source_key,
                    "sourceBox": {
                        "x": left,
                        "y": top,
                        "width": expected_size[0],
                        "height": expected_size[1],
                    },
                    "output": info,
                    "purpose": spec["purpose"],
                    "limitations": spec["limitations"],
                }
            )
    return assets


def geometric_alpha(
    size: tuple[int, int],
    shapes: tuple[tuple[str, tuple[int, int, int, int], int], ...],
    scale: int = 4,
) -> Image.Image:
    """用高分辨率几何轮廓生成抗锯齿透明蒙版。"""
    canvas = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    draw = ImageDraw.Draw(canvas)
    for kind, box, radius in shapes:
        scaled_box = tuple(value * scale for value in box)
        if kind == "rectangle":
            draw.rectangle(scaled_box, fill=255)
        elif kind == "ellipse":
            draw.ellipse(scaled_box, fill=255)
        elif kind == "rounded_rectangle":
            draw.rounded_rectangle(scaled_box, radius=radius * scale, fill=255)
        else:
            raise ValueError(f"不支持的蒙版形状：{kind}")
    return canvas.resize(size, Image.Resampling.LANCZOS)


def extract_cutouts(target: Path, output_dir: Path) -> list[dict[str, Any]]:
    """按视觉物体的实际几何边界生成透明精灵。"""
    assets: list[dict[str, Any]] = []
    with Image.open(target) as target_image:
        target_image.load()
        for spec in CUTOUT_SPECS:
            left, top, right, bottom = spec["box"]
            box = (left, top, right, bottom)
            foreground = target_image.crop(box).convert("RGBA")
            foreground.putalpha(geometric_alpha(foreground.size, spec["shapes"]))

            output_path = output_dir / spec["filename"]
            foreground.save(output_path, format="PNG", optimize=True)
            expected_size = (right - left, bottom - top)
            info = validate_png(output_path, expected_size)
            if info["mode"] != "RGBA":
                raise ValueError(f"透明精灵必须为 RGBA：{output_path}")
            assets.append(
                {
                    "id": spec["id"],
                    "file": spec["filename"],
                    "process": "manual supersampled geometry mask",
                    "source": "targetSource",
                    "sourceBox": {
                        "x": left,
                        "y": top,
                        "width": expected_size[0],
                        "height": expected_size[1],
                    },
                    "mask": {
                        "supersample": 4,
                        "shapes": [
                            {"type": kind, "box": list(shape_box), "radius": radius}
                            for kind, shape_box, radius in spec["shapes"]
                        ],
                    },
                    "output": info,
                    "purpose": spec["purpose"],
                    "limitations": spec["limitations"],
                }
            )
    return assets


def extract_paper_texture(target: Path, output_dir: Path) -> dict[str, Any]:
    """从右侧空白纸面构造四边闭合的镜像平铺纹理。"""
    left, top, right, bottom = PAPER_TEXTURE_SPEC["box"]
    with Image.open(target) as target_image:
        target_image.load()
        sample = target_image.crop((left, top, right, bottom)).convert("RGB")

    horizontal = Image.new("RGB", (sample.width * 2, sample.height))
    horizontal.paste(sample, (0, 0))
    horizontal.paste(sample.transpose(Image.Transpose.FLIP_LEFT_RIGHT), (sample.width, 0))
    tiled = Image.new("RGB", (horizontal.width, horizontal.height * 2))
    tiled.paste(horizontal, (0, 0))
    tiled.paste(horizontal.transpose(Image.Transpose.FLIP_TOP_BOTTOM), (0, horizontal.height))

    output_path = output_dir / PAPER_TEXTURE_SPEC["filename"]
    tiled.save(output_path, format="PNG", optimize=True)
    info = validate_png(output_path, tiled.size)

    first_column = tiled.crop((0, 0, 1, tiled.height))
    last_column = tiled.crop((tiled.width - 1, 0, tiled.width, tiled.height))
    first_row = tiled.crop((0, 0, tiled.width, 1))
    last_row = tiled.crop((0, tiled.height - 1, tiled.width, tiled.height))
    if ImageChops.difference(first_column, last_column).getbbox() is not None:
        raise ValueError("纸纹理左右边缘不闭合")
    if ImageChops.difference(first_row, last_row).getbbox() is not None:
        raise ValueError("纸纹理上下边缘不闭合")

    return {
        "id": PAPER_TEXTURE_SPEC["id"],
        "file": PAPER_TEXTURE_SPEC["filename"],
        "process": "2x2 mirrored seamless tile",
        "source": "targetSource",
        "sourceBox": {
            "x": left,
            "y": top,
            "width": right - left,
            "height": bottom - top,
        },
        "output": info,
        "tile": {
            "repeatX": True,
            "repeatY": True,
            "oppositeEdgesPixelEqual": True,
        },
        "purpose": PAPER_TEXTURE_SPEC["purpose"],
        "limitations": PAPER_TEXTURE_SPEC["limitations"],
    }


def copy_clean_plate(clean_plate: Path, output_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """复制生成的干净底图；外部来源不可用时复用已入库的副本。"""
    output_path = output_dir / "ludo-cleanplate-v1.png"
    if clean_plate.exists():
        clean_info = validate_png(clean_plate, EXPECTED_CANVAS_SIZE)
        if clean_plate.resolve() != output_path.resolve():
            shutil.copyfile(clean_plate, output_path)
    elif not output_path.exists():
        raise FileNotFoundError(
            f"干净底图不存在：{clean_plate}；仓库内也没有可复用的 {output_path}"
        )
    else:
        clean_info = validate_png(output_path, EXPECTED_CANVAS_SIZE)

    output_info = validate_png(output_path, EXPECTED_CANVAS_SIZE)
    if clean_info["sha256"] != output_info["sha256"]:
        raise ValueError("干净底图复制后 SHA-256 不一致")

    source = {
        "path": portable_source_path(clean_plate),
        "width": clean_info["width"],
        "height": clean_info["height"],
        "sha256": clean_info["sha256"],
    }
    asset = {
        "id": "ludo_cleanplate_v1",
        "file": output_path.name,
        "process": "copy",
        "source": "cleanPlateSource",
        "sourceBox": {"x": 0, "y": 0, "width": 1536, "height": 1024},
        "output": output_info,
        "purpose": "clean plate：移除红黄棋子和骰子后的 1536x1024 全屏视觉底图，供动态精灵叠加。",
        "limitations": "页头、面板文字、按钮和状态文案仍为底图内容；交互热区需由前端覆盖。",
    }
    return source, asset


def ensure_no_replacement_character(paths: list[Path]) -> None:
    """检查本脚本与 manifest 中不存在 Unicode 替换字符 U+FFFD。"""
    for path in paths:
        text = path.read_text(encoding="utf-8")
        if "\ufffd" in text:
            raise ValueError(f"检测到 Unicode 替换字符 U+FFFD：{path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="1536x1024 复古视觉稿")
    parser.add_argument(
        "--clean-plate",
        type=Path,
        default=DEFAULT_CLEAN_PLATE,
        help="1536x1024 去棋子、去骰子的干净底图",
    )
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="PNG 与 manifest 输出目录")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    output_dir = args.output_dir.resolve()
    clean_plate = args.clean_plate.resolve()

    if not source.exists():
        raise FileNotFoundError(f"视觉稿不存在：{source}")

    output_dir.mkdir(parents=True, exist_ok=True)
    target_source = source_record(source)
    clean_source, clean_asset = copy_clean_plate(clean_plate, output_dir)
    clean_plate_output = output_dir / clean_asset["file"]
    assets = [clean_asset]
    assets.extend(crop_assets(source, output_dir, CROP_SPECS, "targetSource"))
    assets.extend(
        crop_assets(clean_plate_output, output_dir, CLEAN_PLATE_CROP_SPECS, "cleanPlateSource")
    )
    assets.extend(extract_cutouts(source, output_dir))
    assets.append(extract_paper_texture(source, output_dir))
    outer_chrome_path = output_dir / "outer-chrome.png"
    with Image.open(source) as target_image:
        outer_chrome = target_image.convert("RGBA")
        for left, top, right, bottom in ((91, 85, 954, 943), (968, 85, 1442, 967)):
            clear_region = Image.new("RGBA", (right - left, bottom - top), (0, 0, 0, 0))
            outer_chrome.paste(clear_region, (left, top))
        outer_chrome.save(outer_chrome_path, "PNG", optimize=True)
    outer_chrome_info = validate_png(outer_chrome_path, EXPECTED_CANVAS_SIZE)
    assets.append(
        {
            "id": "outer_chrome",
            "file": outer_chrome_path.name,
            "process": "transparent mask of targetSource",
            "source": "targetSource",
            "output": outer_chrome_info,
            "purpose": "保留效果稿原始木桌、页头、导航与棋盘脚注，棋盘和记分板区域透明以叠加交互层。",
            "limitations": "按 1536x1024 桌面基准制作；其他桌面尺寸使用居中显示。",
        }
    )
    tabletop_path = output_dir / "tabletop-background.png"
    tabletop_info = validate_png(tabletop_path, EXPECTED_CANVAS_SIZE)
    assets.append(
        {
            "id": "tabletop_background",
            "file": tabletop_path.name,
            "process": "image generation edit from targetSource",
            "source": "targetSource",
            "output": tabletop_info,
            "purpose": "移除全部界面元素后的连续胡桃木桌面底图，避免平铺纹理出现接缝。",
            "promptSummary": "移除棋盘、面板、文字、棋子和阴影，只保留同材质、同光照的 1536x1024 胡桃木桌面。",
            "limitations": "生成式补全素材；以效果稿颜色和纹理连续性为视觉验收标准。",
        }
    )
    tabletop_jpeg_path = output_dir / "tabletop-background.jpg"
    with Image.open(tabletop_path) as tabletop_image:
        tabletop_image.convert("RGB").save(
            tabletop_jpeg_path,
            "JPEG",
            quality=91,
            subsampling=0,
            optimize=True,
            progressive=True,
        )
    tabletop_jpeg_info = validate_jpeg(tabletop_jpeg_path, EXPECTED_CANVAS_SIZE)
    assets.append(
        {
            "id": "tabletop_background_web",
            "file": tabletop_jpeg_path.name,
            "process": "deterministic JPEG derivative of tabletop_background",
            "source": "tabletop_background",
            "output": tabletop_jpeg_info,
            "purpose": "单文件网页内嵌使用的胡桃木桌面压缩版本。",
            "limitations": "有损压缩质量 91，4:4:4 色度采样。",
        }
    )

    manifest = {
        "manifestVersion": 1,
        "coordinateConvention": "Pillow left-top inclusive, right-bottom exclusive",
        "targetSource": target_source,
        "cleanPlateSource": clean_source,
        "assets": assets,
    }
    manifest_path = output_dir / "manifest.json"
    with manifest_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    ensure_no_replacement_character([Path(__file__).resolve(), manifest_path])
    for asset in assets:
        output_path = output_dir / asset["file"]
        expected_size = (asset["output"]["width"], asset["output"]["height"])
        if output_path.suffix.lower() == ".jpg":
            validate_jpeg(output_path, expected_size)
        else:
            validate_png(output_path, expected_size)

    print(f"Generated {len(assets)} visual asset files: {output_dir}")
    print(f"Manifest: {manifest_path}")
    print("PNG decode, dimensions, SHA-256 and U+FFFD checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
