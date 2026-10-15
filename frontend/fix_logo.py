import os, re, base64, io
from pathlib import Path
from PIL import Image
candidates = []
for folder in [Path("public"), Path.home() / "Downloads", Path(".")]:
    if folder.exists():
        for ext in ("*.png", "*.jpg", "*.jpeg", "*.webp", "*.svg"):
            for p in folder.glob(ext):
                name = p.name.lower()
                if name not in ("vite.svg",) and "screenshot" not in name and "apple support" not in name:
                    candidates.append(p)

candidates.sort(key=lambda x: x.stat().st_mtime, reverse=True)

def strip_white_bg(img_bytes: bytes) -> str:
    img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
    new_data = []
    for r, g, b, a in img.getdata():
        # Strip white / near-white background pixels completely
        if r > 235 and g > 235 and b > 235:
            new_data.append((r, g, b, 0))
        elif r > 210 and g > 210 and b > 210 and (max(r, g, b) - min(r, g, b) < 18):
            alpha = int(a * ((235 - ((r + g + b) / 3)) / 25.0))
            new_data.append((r, g, b, max(0, min(255, alpha))))
        else:
            new_data.append((r, g, b, a))
    img.putdata(new_data)
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    out = io.BytesIO()
    img.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode("ascii")

os.makedirs("public", exist_ok=True)
target_svg = Path("public/favicon.svg")

source = candidates[0] if candidates else None
if source:
    print("Found logo:", source)
    if source.suffix.lower() == ".svg":
        txt = source.read_text(errors="ignore")
        m = re.search(r'data:image/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)', txt)
        if m:
            b64 = strip_white_bg(base64.b64decode(m.group(2)))
            target_svg.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="background:none"><image width="512" height="512" href="data:image/png;base64,{b64}" preserveAspectRatio="xMidYMid meet"/></svg>')
        else:
            txt = re.sub(r'<rect[^>]*fill=["\'](#fff|#ffffff|white|rgb\(255,\s*255,\s*255\))["\'][^>]*/?>', '', txt, flags=re.I)
            target_svg.write_text(txt)
    else:
        b64 = strip_white_bg(source.read_bytes())
        target_svg.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="background:none"><image width="512" height="512" href="data:image/png;base64,{b64}" preserveAspectRatio="xMidYMid meet"/></svg>')
    print("Created transparent public/favicon.svg!")
app_file = Path("src/App.tsx")
code = app_file.read_text()

# Remove watermark element
code = re.sub(r'<div[^>]*dg-watermark[^>]*>.*?</div>', '', code, flags=re.DOTALL)

# Replace the blue box + <Droplets /> icon with standalone transparent SVG image
code = re.sub(
    r'<span[^>]*>\s*<Droplets[^>]*/>\s*</span>',
    '<img src="/favicon.svg?v=clean1" alt="DrainGRID" className="h-9 w-9 shrink-0 object-contain bg-transparent" />',
    code,
    flags=re.DOTALL
)
app_file.write_text(code)
css_file = Path("src/index.css")
css_file.write_text(css_file.read_text() + "\n.dg-watermark { display: none !important; }\n")
html_file = Path("index.html")
html = re.sub(r'<link\s+rel="icon"[^>]*>', '<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=clean1" />', html_file.read_text())
html_file.write_text(html)
print("ALL DONE! Logo swapped, white background stripped, and watermark removed.")
