#!/usr/bin/env python3
"""Generate the app icon set with Pillow: navy full-bleed background (maskable-safe),
white speech bubble, and the glyph 通 (통/つう · 'to interpret/communicate').
Outputs icons/icon-192.png, icon-512.png, apple-touch-icon-180.png, favicon-32.png,
favicon-16.png and icons/favicon.ico (16/32/48). Deterministic for a given Pillow/font."""
from PIL import Image, ImageDraw, ImageFont
import os, struct, zlib

def save_png_filter0(im, path):
    """Write an 8-bit RGB PNG with filter type 0 on every scanline (the app's test parser only reads filter 0)."""
    w, h = im.size; px = im.convert('RGB').tobytes()
    raw = b''.join(b'\x00' + px[y * w * 3:(y + 1) * w * 3] for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
NAVY = (31, 95, 139); WHITE = (255, 255, 255)
FONT = '/System/Library/Fonts/AppleSDGothicNeo.ttc'
root = os.path.join(os.path.dirname(__file__), '..', 'icons'); os.makedirs(root, exist_ok=True)

def render(size):
    S = 8  # supersample
    W = size * S
    im = Image.new('RGB', (W, W), NAVY); d = ImageDraw.Draw(im)
    # speech bubble: rounded rect + tail (bottom-left)
    m = W * 0.13; r = W * 0.16
    x0, y0, x1, y1 = m, m * 1.05, W - m, W - m * 1.45
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=WHITE)
    tail = [(x0 + W * 0.12, y1 - W * 0.01), (x0 + W * 0.30, y1 - W * 0.01), (x0 + W * 0.10, y1 + W * 0.12)]
    d.polygon(tail, fill=WHITE)
    # glyph
    glyph = '通'
    fsize = int(W * 0.46)
    try:
        font = ImageFont.truetype(FONT, fsize, index=0)
    except Exception:
        font = ImageFont.load_default()
    bbox = d.textbbox((0, 0), glyph, font=font)
    gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx = (x0 + x1) / 2 - bbox[0] - gw / 2
    cy = (y0 + y1) / 2 - bbox[1] - gh / 2
    d.text((cx, cy), glyph, font=font, fill=NAVY)
    return im.resize((size, size), Image.LANCZOS)

out = {}
for size, name in [(512, 'icon-512.png'), (192, 'icon-192.png'), (180, 'apple-touch-icon-180.png'), (32, 'favicon-32.png'), (16, 'favicon-16.png')]:
    im = render(size); save_png_filter0(im, os.path.join(root, name)); out[size] = im
ico = [render(s) for s in (16, 32, 48)]
ico[0].save(os.path.join(root, 'favicon.ico'), format='ICO', sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico[1:])
print('icons written:', sorted(os.listdir(root)))
