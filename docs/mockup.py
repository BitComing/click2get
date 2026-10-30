import math
from PIL import Image, ImageDraw, ImageFont

S = 2
W, H = 1280, 800

# palette
BG        = "#0E0E10"
SIDEBAR   = "#131317"
CARD      = "#17171B"
CARD_ALT  = "#0F0F12"
TEXT      = "#EDEDEF"
TEXT_2    = "#A0A0A8"
TEXT_3    = "#6B6B75"
ACCENT    = "#3ECF8E"
HAIR      = (255, 255, 255, 13)

def X(v): return int(round(v * S))

def font(size, weight="r"):
    if weight == "m":
        return ImageFont.truetype("C:/Windows/Fonts/consola.ttf", size * S)
    p = "C:/Windows/Fonts/msyhbd.ttc" if weight == "b" else "C:/Windows/Fonts/msyh.ttc"
    return ImageFont.truetype(p, size * S)

F_11   = font(11)
F_12   = font(12)
F_13   = font(13)
F_13B  = font(13, "b")
F_14   = font(14)
F_15   = font(15)
F_15B  = font(15, "b")
F_20B  = font(20, "b")
F_MONO = font(12, "m")

img = Image.new("RGB", (W * S, H * S), BG)
d = ImageDraw.Draw(img, "RGBA")

def rr(x, y, w, h, r, fill=None, outline=None, width=1):
    d.rounded_rectangle([X(x), X(y), X(x + w), X(y + h)], radius=X(r),
                        fill=fill, outline=outline, width=X(width))

def txt(x, y, s, f, color):
    d.text((X(x), X(y)), s, font=f, fill=color)

def wrap(s, f, maxw):
    lines, cur = [], ""
    for ch in s:
        if d.textlength(cur + ch, font=f) > X(maxw):
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur: lines.append(cur)
    return lines

# ---------------- sidebar ----------------
d.rectangle([0, 0, X(248), X(H)], fill=SIDEBAR)
d.line([X(248), 0, X(248), X(H)], fill=(255, 255, 255, 15), width=S)

# logo
rr(22, 26, 26, 26, 8, fill="#2A2A31")
d.ellipse([X(29), X(33), X(41), X(45)], fill=ACCENT)
txt(58, 27, "Click2Get", F_15B, TEXT)
txt(58, 47, "捕获即笔记", F_11, TEXT_3)

def nav_item(y, label, active=False, count=None, icon=None):
    if active:
        rr(12, y, 224, 34, 8, fill="#1E1E24")
    c = TEXT if active else TEXT_2
    ix, iy = 28, y + 10
    if icon == "inbox":
        d.rounded_rectangle([X(ix), X(iy + 2), X(ix + 14), X(iy + 12)], radius=X(2),
                            outline=c, width=S)
        d.line([X(ix), X(iy + 7), X(ix + 4), X(iy + 7), X(ix + 5.5), X(iy + 9),
                X(ix + 8.5), X(iy + 9), X(ix + 10), X(iy + 7), X(ix + 14), X(iy + 7)],
               fill=c, width=S)
    elif icon == "archive":
        d.rounded_rectangle([X(ix), X(iy + 2), X(ix + 14), X(iy + 12)], radius=X(2),
                            outline=c, width=S)
        d.line([X(ix), X(iy + 6), X(ix + 14), X(iy + 6)], fill=c, width=S)
    elif icon == "star":
        pts = []
        for i in range(10):
            a = -math.pi / 2 + i * math.pi / 5
            rad = 7 if i % 2 == 0 else 3
            pts.append((X(ix + 7 + rad * math.cos(a)), X(iy + 7 + rad * math.sin(a))))
        d.polygon(pts, outline=c, width=S)
    elif icon == "gear":
        d.ellipse([X(ix + 1), X(iy + 1), X(ix + 13), X(iy + 13)], outline=c, width=S)
        d.ellipse([X(ix + 5), X(iy + 5), X(ix + 9), X(iy + 9)], fill=c)
    txt(54, y + 9, label, F_14 if not active else F_14, c)
    if count:
        w = d.textlength(count, font=F_11) / S + 14
        rr(236 - w - 10, y + 9, w, 17, 8.5, fill="#26262D")
        txt(236 - w - 10 + 7, y + 11, count, F_11, TEXT_2)

nav_item(96, "收件箱", True, "47", "inbox")
nav_item(136, "归档", False, None, "archive")
nav_item(176, "收藏", False, None, "star")

d.line([X(12), X(716), X(236), X(716)], fill=(255, 255, 255, 15), width=S)
nav_item(732, "设置", False, None, "gear")

# ---------------- header ----------------
txt(404, 32, "收件箱", F_20B, TEXT)
txt(478, 40, "47 条捕获 · 今天", F_12, TEXT_3)

# listening pill
pw = 92
rr(1124 - pw, 30, pw, 28, 14, fill=(62, 207, 142, 26), outline=(62, 207, 142, 60), width=1)
d.ellipse([X(1124 - pw + 12), X(41), X(1124 - pw + 19), X(48)], fill=ACCENT)
txt(1124 - pw + 25, 37, "监听中", F_12, ACCENT)

# ---------------- cards ----------------
def card(y, h, time, app, dotcolor):
    rr(404, y, 720, h, 12, fill=CARD, outline=HAIR, width=1)
    txt(420, y + 14, time, F_11, TEXT_3)
    d.ellipse([X(462), X(y + 18), X(468), X(y + 24)], fill=dotcolor)
    txt(474, y + 14, app, F_11, TEXT_2)

# card 1: text
y1 = 96
body = "Rust 的借用检查器本质上是在编译期做一次别名分析 —— 它并不理解内存，只理解「谁在什么时候拥有引用」。"
lines = wrap(body, F_15, 688)
card(y1, 30 + 8 + len(lines) * 26 + 12, "14:32", "Chrome", "#5B8DEF")
for i, ln in enumerate(lines):
    txt(420, y1 + 38 + i * 26, ln, F_15, "#DCDCE0")

# card 2: images
y2 = 96 + (30 + 8 + len(lines) * 26 + 12) + 18
card(y2, 30 + 8 + 96 + 14, "14:35", "截图工具", "#A78BFA")

def thumb(x, y, w, h, kind):
    rr(x, y, w, h, 8, fill="#202026", outline=HAIR, width=1)
    if kind == 1:
        d.rectangle([X(x), X(y), X(x + w), X(y + 14)], fill="#26262D")
        for i in range(3):
            d.ellipse([X(x + 8 + i * 10), X(y + 5), X(x + 13 + i * 10), X(y + 10)], fill="#3A3A44")
        for i in range(4):
            d.rounded_rectangle([X(x + 10), X(y + 26 + i * 14), X(x + w - 10 - i * 22), X(y + 34 + i * 14)],
                                radius=X(2), fill="#2C2C34")
    elif kind == 2:
        d.rectangle([X(x), X(y), X(x + w), X(y + 14)], fill="#26262D")
        for i in range(5):
            col = [("#3ECF8E", 46), ("#5B8DEF", 30), ("#6B6B75", 60), ("#A78BFA", 24), ("#6B6B75", 40)][i]
            d.rounded_rectangle([X(x + 10 + (0 if i % 2 == 0 else 14)), X(y + 24 + i * 13),
                                 X(x + 10 + (0 if i % 2 == 0 else 14) + col[1]), X(y + 31 + i * 13)],
                                radius=X(2), fill=col[0])
    else:
        d.rectangle([X(x), X(y), X(x + w), X(y + 14)], fill="#26262D")
        for i, hh in enumerate([18, 30, 22, 40]):
            d.rounded_rectangle([X(x + 14 + i * 20), X(y + 76 - hh), X(x + 26 + i * 20), X(y + 76)],
                                radius=X(2), fill="#3A3A46")
        d.line([X(x + 10), X(y + 78), X(x + w - 10), X(y + 78)], fill="#2C2C34", width=S)

tw = (688 - 24) / 3
for i in range(3):
    thumb(420 + i * (tw + 12), y2 + 38, tw, 96, i + 1)

# card 3: code
y3 = y2 + (30 + 8 + 96 + 14) + 18
card(y3, 30 + 8 + 76 + 14, "14:41", "VS Code", "#22D3EE")
rr(420, y3 + 38, 688, 76, 8, fill=CARD_ALT)
code = [
    ("fn main() {", "#C8C8CE"),
    ("    let clips = Capture::watch()?;", "#A0A0A8"),
    ("    clips.each(|c| note.push(c));", "#A0A0A8"),
    ("}", "#C8C8CE"),
]
for i, (ln, c) in enumerate(code):
    txt(432, y3 + 48 + i * 17, ln, F_MONO, c)

# card 4
y4 = y3 + (30 + 8 + 76 + 14) + 18
card(y4, 30 + 8 + 26 * 2 + 12, "14:47", "Edge", "#F472B6")
for i, ln in enumerate(wrap("所有复制的内容会按时间顺序落进这一篇笔记，无需手动整理。", F_15, 688)):
    txt(420, y4 + 38 + i * 26, ln, F_15, "#DCDCE0")

# card 5 (clipped by the fade — implies the list continues)
y5 = y4 + (30 + 8 + 52 + 12) + 18
card(y5, 30 + 8 + 96 + 14, "14:52", "Chrome", "#5B8DEF")
for i in range(3):
    thumb(420 + i * (tw + 12), y5 + 38, tw, 96, (i + 1) % 3 + 1)

# ---------------- overlay scrollbar ----------------
rr(1146, 96, 4, 132, 2, fill=(255, 255, 255, 28))

# ---------------- bottom fade ----------------
FH = 118
fade = Image.new("L", (W * S, X(FH)), 0)
fd = ImageDraw.Draw(fade)
for i in range(X(FH)):
    fd.line([(0, i), (W * S, i)], fill=int(255 * (i / X(FH)) ** 1.7))
img.paste(Image.new("RGB", fade.size, BG), (0, H * S - X(FH)), fade)

img = img.resize((W, H), Image.LANCZOS)
img.save("docs/ui-mockup.png")
print("saved", img.size)