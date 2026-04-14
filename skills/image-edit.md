---
name: image-edit
description: Use this skill when the user wants to edit or create images manually — thumbnails, text overlays, backgrounds, crop, resize, composite, logos, blur, YouTube/social media banners. Do NOT use this for infographics, podcasts, quizzes, flashcards, or reports generated FROM a document/PDF/URL — use the notebooklm skill for those instead.
---

# Image Editing Guide

## Stack — always use skia-python only
- **skia-python** — Google's Skia engine, smooth text, shapes, compositing
- **Never use Pillow** for drawing or text — produces black images
- Pillow is ONLY allowed for opening/resizing source images before passing to skia

## Setup check
```python
import skia
print("skia ready")
```

## Always save output to
`C:/Blopus/output/image_output.png`

---

## Core Pattern — always follow this structure

```python
import skia
import os

OUTPUT = "C:/Blopus/output/image_output.png"
os.makedirs("C:/Blopus/output", exist_ok=True)

# Canvas size — adjust per task
WIDTH, HEIGHT = 1280, 720

surface = skia.Surface(WIDTH, HEIGHT)
canvas = surface.getCanvas()

# Draw everything here
# ...

# Save
image = surface.makeImageSnapshot()
image.save(OUTPUT, skia.kPNG)
print(f"Saved: {OUTPUT}")
```

---

## Backgrounds

### Solid color background
```python
canvas.clear(skia.Color(0, 0, 0, 255))  # Black
canvas.clear(skia.Color(255, 255, 255, 255))  # White
canvas.clear(skia.Color(30, 30, 30, 255))  # Dark gray
```

### Gradient background
```python
paint = skia.Paint()
paint.setShader(skia.GradientShader.MakeLinear(
    points=[(0, 0), (WIDTH, HEIGHT)],
    colors=[skia.Color(102, 0, 204), skia.Color(0, 102, 255)]
))
canvas.drawRect(skia.Rect.MakeWH(WIDTH, HEIGHT), paint)
```

---

## Load and place an image on canvas

```python
from PIL import Image as PILImage
import numpy as np

def load_image_to_skia(path, target_w=None, target_h=None):
    pil_img = PILImage.open(path).convert("RGBA")
    if target_w and target_h:
        pil_img = pil_img.resize((target_w, target_h), PILImage.LANCZOS)
    elif target_w:
        ratio = target_w / pil_img.width
        pil_img = pil_img.resize((target_w, int(pil_img.height * ratio)), PILImage.LANCZOS)
    arr = np.array(pil_img)
    return skia.Image.fromarray(arr)

# Place image at position (x, y)
img = load_image_to_skia("path/to/image.png", target_w=600)
canvas.drawImage(img, x=50, y=60)
```

---

## Text

### Simple text
```python
paint = skia.Paint(Color=skia.Color(255, 255, 255, 255))
font = skia.Font(skia.Typeface('Arial'), 64)
canvas.drawString("Your Text Here", x=100, y=200, font=font, paint=paint)
```

### Bold text
```python
tf = skia.Typeface('Arial', skia.FontStyle.Bold())
font = skia.Font(tf, 72)
paint = skia.Paint(Color=skia.Color(255, 220, 0, 255))
canvas.drawString("BOLD TEXT", 80, 300, font, paint)
```

### Text with shadow
```python
shadow_paint = skia.Paint(Color=skia.Color(0, 0, 0, 180))
font = skia.Font(skia.Typeface('Arial', skia.FontStyle.Bold()), 72)
canvas.drawString("Text Here", 82, 302, font, shadow_paint)
text_paint = skia.Paint(Color=skia.Color(255, 255, 255, 255))
canvas.drawString("Text Here", 80, 300, font, text_paint)
```

### Multiline text
```python
font = skia.Font(skia.Typeface('Arial', skia.FontStyle.Bold()), 56)
paint = skia.Paint(Color=skia.Color(255, 255, 255, 255))
lines = ["First Line", "Second Line", "Third Line"]
y = 200
for line in lines:
    canvas.drawString(line, 80, y, font, paint)
    y += 70
```

---

## Shapes

### Rectangle
```python
paint = skia.Paint(Color=skia.Color(255, 0, 0, 255))
canvas.drawRect(skia.Rect.MakeLTRB(50, 50, 300, 200), paint)
```

### Rounded rectangle
```python
paint = skia.Paint(Color=skia.Color(50, 50, 50, 200))
canvas.drawRoundRect(skia.Rect.MakeLTRB(40, 40, 400, 120), 20, 20, paint)
```

### Semi-transparent overlay
```python
overlay = skia.Paint(Color=skia.Color(0, 0, 0, 140))
canvas.drawRect(skia.Rect.MakeLTRB(0, HEIGHT-150, WIDTH, HEIGHT), overlay)
```

---

## Common Thumbnail Layouts

### Image left, text right (black background)
CRITICAL RULE: Subject/character goes on the LEFT half (x=0 to 640). Text goes on the RIGHT half only (x=660+). NEVER place text over the subject — it ruins the thumbnail.
```python
canvas.clear(skia.Color(10, 10, 10, 255))
# Subject fills LEFT half — draw at x=0, keep within x=0..640
img = load_image_to_skia("path/to/photo.png", target_w=620, target_h=700)
canvas.drawImage(img, 0, 10)
# Text goes in RIGHT half only — x starts at 660, never less
font_big = skia.Font(skia.Typeface('Arial', skia.FontStyle.Bold()), 72)
font_small = skia.Font(skia.Typeface('Arial', skia.FontStyle.Bold()), 44)
white = skia.Paint(Color=skia.Color(255, 255, 255, 255))
yellow = skia.Paint(Color=skia.Color(255, 220, 0, 255))
canvas.drawString("MAIN TITLE", 665, 280, font_big, white)
canvas.drawString("Subtitle here", 665, 370, font_small, yellow)
```

### Full background image + text overlay
```python
img = load_image_to_skia("path/to/bg.png", target_w=WIDTH, target_h=HEIGHT)
canvas.drawImage(img, 0, 0)
overlay = skia.Paint(Color=skia.Color(0, 0, 0, 160))
canvas.drawRect(skia.Rect.MakeWH(WIDTH, HEIGHT), overlay)
font = skia.Font(skia.Typeface('Arial', skia.FontStyle.Bold()), 80)
paint = skia.Paint(Color=skia.Color(255, 255, 255, 255))
canvas.drawString("YOUR TITLE", 80, 360, font, paint)
```

### Two images side by side
```python
canvas.clear(skia.Color(0, 0, 0, 255))
img1 = load_image_to_skia("left.png", target_w=600, target_h=720)
img2 = load_image_to_skia("right.png", target_w=600, target_h=720)
canvas.drawImage(img1, 0, 0)
canvas.drawImage(img2, 640, 0)
div_paint = skia.Paint(Color=skia.Color(255, 255, 0, 255))
canvas.drawRect(skia.Rect.MakeLTRB(630, 0, 640, HEIGHT), div_paint)
```

### YouTube thumbnail (gradient bg + logo + title)
```python
WIDTH, HEIGHT = 1280, 720
surface = skia.Surface(WIDTH, HEIGHT)
canvas = surface.getCanvas()
paint = skia.Paint()
paint.setShader(skia.GradientShader.MakeLinear(
    points=[(0, 0), (WIDTH, HEIGHT)],
    colors=[skia.Color(10, 10, 40), skia.Color(60, 0, 120)]
))
canvas.drawRect(skia.Rect.MakeWH(WIDTH, HEIGHT), paint)
font_title = skia.Font(skia.Typeface('Arial', skia.FontStyle.Bold()), 90)
white = skia.Paint(Color=skia.Color(255, 255, 255, 255))
canvas.drawString("MAIN TITLE", 80, 380, font_title, white)
font_sub = skia.Font(skia.Typeface('Arial'), 42)
yellow = skia.Paint(Color=skia.Color(255, 220, 0, 255))
canvas.drawString("subtitle goes here", 80, 450, font_sub, yellow)
```

---

## Canvas sizes
- YouTube thumbnail: 1280x720
- Instagram square: 1080x1080
- Twitter/X header: 1500x500
- Instagram story: 1080x1920

## Rules — follow every time
1. Always use skia for ALL drawing, text, shapes, compositing
2. Pillow ONLY for opening source images before passing to skia — never for drawing
3. Always save to `C:/Blopus/output/image_output.png`
4. Always tell owner: "Saved at C:/Blopus/output/image_output.png — open it to check"
5. When user sends an image — it gets saved to C:/Blopus/tmp/ — use that path as source
6. Never hardcode font paths — use font names like 'Arial'
7. This skill is for EDITING only — not AI image generation
8. By default, do NOT alter source image colours — load and draw as-is. Only change colours if the user explicitly asks.
9. By default, place text in a clear zone away from the subject (right half for left-subject layouts, bottom bar for full-bg layouts). Only place text over the subject if the user explicitly asks for it.
