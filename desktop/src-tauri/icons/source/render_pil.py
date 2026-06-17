"""Render the final C4 icon + tray glyph with PIL (true alpha, supersampled)."""
from __future__ import annotations
import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "final"
OUT.mkdir(exist_ok=True)

INK = (27, 42, 74, 255)        # #1B2A4A
ACCENT = (232, 162, 60, 255)   # #E8A23C
PAPER = (243, 236, 221, 255)   # #F3ECDD
BASE_BLEND = (220, 211, 191, 255)  # baseline @0.55 over paper

SS = 4  # supersample factor


# ── helpers ──────────────────────────────────────────────────────────────────
def wave_points(x0, x1, cy, amp, n, steps=400):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = x0 + (x1 - x0) * t
        env = math.sin(math.pi * t) ** 0.7
        y = cy - math.sin(2 * math.pi * n * t) * amp * env
        pts.append((x, y))
    return pts


def cubic(p0, c0, c1, p1, steps=24):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3*p0[0] + 3*u*u*t*c0[0] + 3*u*t*t*c1[0] + t**3*p1[0]
        y = u**3*p0[1] + 3*u*u*t*c0[1] + 3*u*t*t*c1[1] + t**3*p1[1]
        out.append((x, y))
    return out


def stamp(draw, pts, r, fill):
    """Round-capped/-joined stroke by stamping disks along a point list."""
    for x, y in pts:
        draw.ellipse((x - r, y - r, x + r, y + r), fill=fill)


def densify(pts, max_step):
    out = []
    for a, b in zip(pts, pts[1:]):
        d = math.hypot(b[0]-a[0], b[1]-a[1])
        k = max(1, int(d / max_step))
        for i in range(k):
            t = i / k
            out.append((a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t))
    out.append(pts[-1])
    return out


# ── master app icon (1024) ───────────────────────────────────────────────────
def render_master(size=1024):
    C = size * SS
    a = 824 / 512 * SS          # art -> canvas scale
    off = 100 * SS              # padding
    def A(x, y):                # art space -> canvas
        return (off + x * a, off + y * a)

    img = Image.new("RGBA", (C, C), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # squircle (paper)
    d.rounded_rectangle((off, off, off + 824*SS, off + 824*SS), radius=115*a, fill=PAPER)
    # baseline (pre-blended opaque)
    bp = densify([A(118, 372), A(392, 372)], 2)
    stamp(d, bp, 4*a, BASE_BLEND)
    # wave
    wp = densify([A(*p) for p in wave_points(112, 326, 300, 64, 2)], 2)
    stamp(d, wp, 11*a, INK)

    # pen: local coords -> rotate 32deg cw, scale .95, translate to tip (326,300)
    ang = math.radians(32)
    cos, sin = math.cos(ang), math.sin(ang)
    def P(lx, ly):
        lx *= 0.95; ly *= 0.95
        rx = lx*cos - ly*sin
        ry = lx*sin + ly*cos
        return A(326 + rx, 300 + ry)
    rscale = 0.95 * a
    def cap(p0, p1, r, fill):
        seg = densify([P(*p0), P(*p1)], 2)
        stamp(d, seg, r*rscale, fill)

    # nib polygon
    nib = (cubic((0,0),(-12,-28),(-26,-50),(-18,-86))
           + cubic((-18,-86),(-12,-108),(12,-108),(18,-86))
           + cubic((18,-86),(26,-50),(12,-28),(0,0)))
    d.polygon([P(x, y) for x, y in nib], fill=INK)
    cap((-13, -88), (13, -88), 8, ACCENT)     # collar
    cap((0, -181), (0, -101), 19, INK)        # barrel
    cap((0, -14), (0, -70), 3, ACCENT)        # slit
    hx, hy = P(0, -64)                          # breather hole
    d.ellipse((hx-9*rscale, hy-9*rscale, hx+9*rscale, hy+9*rscale), fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


# ── tray template (monochrome, transparent) ──────────────────────────────────
def render_tray(size=128):
    C = size * SS
    img = Image.new("RGBA", (C, C), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = densify([(x*SS, y*SS) for x, y in wave_points(16, 112, size/2, 40, 2)], 2)
    stamp(d, pts, 6.5*SS, (0, 0, 0, 255))
    return img.resize((size, size), Image.LANCZOS)


m = render_master(1024)
m.save(OUT / "master.png")
t = render_tray(128)
t.save(OUT / "tray.png")
print("master alpha:", m.split()[3].getextrema(), "corner:", m.getpixel((4, 4)))
print("tray alpha:", t.split()[3].getextrema(), "corner:", t.getpixel((2, 2)))
