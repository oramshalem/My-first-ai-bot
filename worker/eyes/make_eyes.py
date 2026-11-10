"""Draws Piko's "rainbow" eyes as animated GIFs for the xiaozhi screen (360x360).

The GIFs are committed next to this script, so nobody has to run it unless the
look changes. Needs Python 3 with Pillow:  python make_eyes.py
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 360
SS = 2  # draw at 2x and scale down, for smooth edges
OUT = Path(__file__).parent

BG_EDGE = (7, 4, 12)
BG_CENTER = (26, 11, 54)
GRADIENT = [(169, 139, 255), (255, 143, 214), (255, 215, 122)]  # violet, pink, yellow
GLOW = (199, 123, 255)
CHEEK = (255, 105, 190)

EYE_W, EYE_H, GAP, CY = 60, 140, 114, 172


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_color(t):
    t = min(max(t, 0), 1) * (len(GRADIENT) - 1)
    i = min(int(t), len(GRADIENT) - 2)
    return lerp(GRADIENT[i], GRADIENT[i + 1], t - i)


def make_background():
    n = SIZE * SS
    img = Image.new("RGB", (n, n), BG_EDGE)
    px = img.load()
    c = n / 2
    for y in range(n):
        for x in range(n):
            d = math.hypot(x - c, y - c) / (190 * SS)
            px[x, y] = lerp(BG_CENTER, BG_EDGE, min(max((d - 0.1) / 0.9, 0), 1))
    return img


def make_gradient(vertical):
    n = SIZE * SS
    img = Image.new("RGB", (n, n))
    d = ImageDraw.Draw(img)
    for i in range(n):
        if vertical:
            # spread the gradient over the height of one eye, around the eye line
            t = (i - (CY - EYE_H / 2) * SS) / (EYE_H * SS)
            d.line([(0, i), (n, i)], fill=gradient_color(t))
        else:
            # left to right across each eye on its own
            x = i / SS
            left = SIZE / 2 - GAP / 2 if x < SIZE / 2 else SIZE / 2 + GAP / 2
            d.line([(i, 0), (i, n)], fill=gradient_color((x - left + 46) / 92))
    return img


BACKGROUND = make_background()
VERTICAL = make_gradient(True)
HORIZONTAL = make_gradient(False)


def frame(open_=1.0, lx=0.0, ly=0.0, bob=0.0, happy=False, cheeks=1.0):
    """One frame. open_ is how open the eyes are (1 = fully, ~0 = closed line)."""
    n = SIZE * SS
    mask = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(mask)
    cy = CY + bob
    for side in (-1, 1):
        cx = SIZE / 2 + side * GAP / 2 + lx
        ey = cy + ly
        if happy:
            # a thick upside-down U, drawn as a row of dots along the arc
            r, ccy = 34, ey + 20
            for k in range(41):
                a = math.radians(200 + 140 * k / 40)
                x, y = cx + r * math.cos(a), ccy + r * math.sin(a)
                d.ellipse([(x - 12) * SS, (y - 12) * SS, (x + 12) * SS, (y + 12) * SS], fill=255)
        else:
            h = max(EYE_H * open_, 14)
            w = EYE_W
            box = [(cx - w / 2) * SS, (ey - h / 2) * SS, (cx + w / 2) * SS, (ey + h / 2) * SS]
            d.rounded_rectangle(box, radius=min(w, h) / 2 * SS, fill=255)

    img = BACKGROUND.copy()

    if cheeks > 0:
        cm = Image.new("L", (n, n), 0)
        cd = ImageDraw.Draw(cm)
        for side in (-1, 1):
            x = SIZE / 2 + side * (GAP / 2 + 46)
            y = cy + EYE_H / 2 + 14
            cd.ellipse([(x - 24) * SS, (y - 12) * SS, (x + 24) * SS, (y + 12) * SS], fill=round(210 * cheeks))
        cm = cm.filter(ImageFilter.GaussianBlur(3 * SS))
        img = Image.composite(Image.new("RGB", (n, n), CHEEK), img, cm)

    glow = mask.filter(ImageFilter.GaussianBlur(16 * SS)).point(lambda v: min(255, int(v * 1.3)))
    img = Image.composite(Image.new("RGB", (n, n), GLOW), img, glow)
    img = Image.composite(HORIZONTAL if happy else VERTICAL, img, mask)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def blink(**kw):
    return [(frame(open_=0.5, **kw), 40), (frame(open_=0.08, **kw), 60), (frame(open_=0.5, **kw), 40)]


def ease(a, b, steps):
    return [a + (b - a) * (1 - math.cos(math.pi * (i + 1) / steps)) / 2 for i in range(steps)]


def neutral():
    f = [(frame(), 2200)]
    f += blink()
    f += [(frame(), 1400)]
    f += [(frame(lx=x), 50) for x in ease(0, -14, 3)]
    f += [(frame(lx=-14), 1100)]
    f += [(frame(lx=x), 50) for x in ease(-14, 10, 4)]
    f += [(frame(lx=10, ly=-3), 900)]
    f += [(frame(lx=x, ly=-3 * x / 10), 50) for x in ease(10, 0, 3)]
    f += [(frame(), 1800)]
    f += blink() + [(frame(), 160)] + blink()
    f += [(frame(), 1200)]
    return f


def speaking():
    out = []
    for i in range(10):
        t = i / 10 * 2 * math.pi
        out.append((frame(open_=1 + 0.04 * math.sin(t), bob=4 * math.sin(t) + 2 * math.sin(2 * t)), 70))
    return out


def thinking():
    out = [(frame(open_=0.62, lx=x, ly=-x), 60) for x in ease(0, 12, 3)]
    for i in range(6):
        t = i / 6 * 2 * math.pi
        out.append((frame(open_=0.62, lx=12 + 2 * math.sin(t), ly=-12 + math.cos(t)), 160))
    return out


def happy():
    out = []
    for i in range(8):
        t = i / 8 * 2 * math.pi
        out.append((frame(happy=True, bob=-3 * abs(math.sin(t))), 80))
    return out


def sleepy():
    out = []
    for i in range(8):
        t = i / 8 * 2 * math.pi
        out.append((frame(open_=0.06, ly=8, bob=3 * math.sin(t), cheeks=0.6), 180))
    return out


def save(name, frames):
    # One shared palette for all frames, so colors do not flicker between frames.
    palette = frames[0][0].quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    images = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im, _ in frames]
    path = OUT / f"{name}.gif"
    images[0].save(path, save_all=True, append_images=images[1:], duration=[ms for _, ms in frames],
                   loop=0, disposal=1, optimize=False)
    print(f"{path.name}: {len(images)} frames, {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    save("neutral", neutral())
    save("speaking", speaking())
    save("thinking", thinking())
    save("happy", happy())
    save("sleepy", sleepy())
