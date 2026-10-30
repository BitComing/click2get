"""Click2Get 图标生成：一次性生成所有打包/托盘所需图标。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "icons")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

ACCENT = (91, 140, 255, 255)      # #5B8CFF
ACCENT_SOFT = (129, 168, 255, 255)
BG = (22, 22, 26, 255)            # #16161A
FG = (237, 237, 239, 255)
MUTE = (107, 107, 117, 255)


def app_icon(size: int) -> Image.Image:
    """深色圆角方块 + 捕捉靶心（外环 + 中心点），象征"捕获"。"""
    s = size * 4                      # 超采样后缩放，边缘更干净
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(s * 0.06)
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=int(s * 0.22), fill=BG)
    # 外环
    cx = cy = s / 2
    r_out = s * 0.30
    w = max(2, int(s * 0.055))
    d.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out], outline=ACCENT, width=w)
    # 内环（更细，营造层次）
    r_in = s * 0.165
    d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in], outline=ACCENT_SOFT, width=max(2, int(s * 0.03)))
    # 中心点
    r_dot = s * 0.075
    d.ellipse([cx - r_dot, cy - r_dot, cx + r_dot, cy + r_dot], fill=FG)
    return img.resize((size, size), Image.LANCZOS)


def tray_icon(size: int, on: bool) -> Image.Image:
    """托盘图标：实心圆点（ON=强调色 / OFF=灰），在深色任务栏上都能看清。"""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = ACCENT if on else MUTE
    r = s * 0.34
    cx = cy = s / 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    # 中间镂空一圈，做成"靶"的缩影，避免和小圆点混淆
    r2 = s * 0.13
    if on:
        d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=(14, 14, 16, 255))
    return img.resize((size, size), Image.LANCZOS)


# 打包用
app_icon(256).save(os.path.join(OUT, "icon.png"))
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
app_icon(256).save(os.path.join(OUT, "icon.ico"), sizes=sizes)
for sz in (32, 128):
    app_icon(sz).save(os.path.join(OUT, f"{sz}x{sz}.png"))

# 托盘用（32px 是 Windows 推荐值，另存 16px 备用）
tray_icon(32, True).save(os.path.join(OUT, "tray-on.png"))
tray_icon(32, False).save(os.path.join(OUT, "tray-off.png"))

print("icons ->", OUT)
for f in sorted(os.listdir(OUT)):
    print(" ", f, os.path.getsize(os.path.join(OUT, f)), "bytes")