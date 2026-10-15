# Génère l'icône KSTermus : PNG 1024 + ICO multi-tailles (16 → 256).
from PIL import Image, ImageDraw, ImageFilter
import math

S = 1024
SS = 4  # suréchantillonnage pour des bords nets

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

def squircle_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def render(size):
    W = size * SS
    pad = int(W * 0.06)
    body = W - 2 * pad
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))

    # Ombre portée douce
    shadow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([pad, pad + int(W * 0.02), pad + body, pad + body + int(W * 0.02)], radius=int(body * 0.23), fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(W * 0.02))
    img.alpha_composite(shadow)

    # Corps : dégradé diagonal ardoise → vert profond
    grad = Image.new('RGBA', (body, body))
    gp = grad.load()
    c1, c2 = (22, 30, 40, 255), (10, 46, 40, 255)
    for y in range(body):
        for x in range(0, body, 1):
            t = (x + y) / (2 * body)
            gp[x, y] = lerp(c1, c2, t)
    mask = squircle_mask(body, int(body * 0.23))
    img.paste(grad, (pad, pad), mask)

    d = ImageDraw.Draw(img)
    # Liseré accent
    d.rounded_rectangle([pad, pad, pad + body - 1, pad + body - 1], radius=int(body * 0.23), outline=(45, 212, 167, 255), width=max(2, int(body * 0.028)))

    # Barre de "fenêtre" : 3 points
    dot_r = body * 0.035
    for i, col in enumerate([(242, 85, 90), (245, 184, 74), (45, 212, 167)]):
        cx = pad + body * (0.17 + i * 0.1); cy = pad + body * 0.17
        d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=col + (255,))

    # Chevron ">" (polygone épais)
    acc = (45, 212, 167, 255)
    th = body * 0.10
    x0, y0 = pad + body * 0.22, pad + body * 0.36
    x1, y1 = pad + body * 0.47, pad + body * 0.55
    x2, y2 = pad + body * 0.22, pad + body * 0.74
    def stroke(p, q, w):
        ang = math.atan2(q[1] - p[1], q[0] - p[0]); nx, ny = -math.sin(ang) * w / 2, math.cos(ang) * w / 2
        d.polygon([(p[0] + nx, p[1] + ny), (q[0] + nx, q[1] + ny), (q[0] - nx, q[1] - ny), (p[0] - nx, p[1] - ny)], fill=acc)
        d.ellipse([q[0] - w / 2, q[1] - w / 2, q[0] + w / 2, q[1] + w / 2], fill=acc)
        d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=acc)
    stroke((x0, y0), (x1, y1), th)
    stroke((x1, y1), (x2, y2), th)

    # Curseur "_"
    cx0, cy = pad + body * 0.55, pad + body * 0.74
    d.rounded_rectangle([cx0, cy - th / 2, cx0 + body * 0.24, cy + th / 2], radius=th / 2, fill=(230, 237, 243, 255))

    return img.resize((size, size), Image.LANCZOS)

big = render(1024)
big.save('assets/icon-1024.png')
render(512).save('assets/icon.png')
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [render(s) for s in sizes]
frames[-1].save('assets/icon.ico', format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
for s, f in zip(sizes, frames): f.save(f'/tmp/icon-{s}.png')
print('ok')
