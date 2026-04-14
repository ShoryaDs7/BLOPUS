---
name: pptx
description: Use this skill whenever the user wants to do anything with PowerPoint (.pptx) files. This includes reading slide content, creating presentations, adding slides, text boxes, images, shapes, tables, charts, formatting, transitions, and converting to PDF or images.
---

# PowerPoint Processing Guide

## Quick Start

```python
from pptx import Presentation

prs = Presentation("slides.pptx")
for slide in prs.slides:
    for shape in slide.shapes:
        if shape.has_text_frame:
            print(shape.text)
```

## Common Tasks

### Read All Text from PPTX
```python
from pptx import Presentation

prs = Presentation("slides.pptx")
for i, slide in enumerate(prs.slides):
    print(f"\n--- Slide {i+1} ---")
    for shape in slide.shapes:
        if shape.has_text_frame:
            for para in shape.text_frame.paragraphs:
                print(para.text)
```

### Create a Presentation
```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()
slide_layout = prs.slide_layouts[0]  # Title slide
slide = prs.slides.add_slide(slide_layout)

title = slide.shapes.title
subtitle = slide.placeholders[1]
title.text = "My Presentation"
subtitle.text = "Subtitle here"

prs.save("output.pptx")
```

### Add Bullet Slide
```python
from pptx import Presentation
from pptx.util import Inches

prs = Presentation()
bullet_layout = prs.slide_layouts[1]  # Title and Content
slide = prs.slides.add_slide(bullet_layout)
slide.shapes.title.text = "My Points"

tf = slide.placeholders[1].text_frame
tf.text = "First point"
tf.add_paragraph().text = "Second point"
tf.add_paragraph().text = "Third point"

prs.save("bullets.pptx")
```

### Add Image
```python
from pptx import Presentation
from pptx.util import Inches

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank
prs.slides[0].shapes.add_picture("image.png", Inches(1), Inches(1), Inches(4), Inches(3))
prs.save("with_image.pptx")
```

### Add Table
```python
from pptx import Presentation
from pptx.util import Inches

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[6])

table = slide.shapes.add_table(3, 3, Inches(1), Inches(1), Inches(6), Inches(3)).table
for r in range(3):
    for c in range(3):
        table.cell(r, c).text = f"R{r}C{c}"

prs.save("table.pptx")
```

### Format Text
```python
from pptx.util import Pt
from pptx.dml.color import RGBColor

tf = slide.shapes[0].text_frame
para = tf.paragraphs[0]
run = para.runs[0]
run.font.bold = True
run.font.size = Pt(24)
run.font.color.rgb = RGBColor(0xFF, 0x00, 0x00)
```

### Add Shape with Text
```python
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN

txBox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
tf = txBox.text_frame
tf.text = "Custom text box"
tf.paragraphs[0].alignment = PP_ALIGN.CENTER
```

### Get Slide Count and Layout Names
```python
prs = Presentation("slides.pptx")
print(f"Total slides: {len(prs.slides)}")
print("Available layouts:", [layout.name for layout in prs.slide_layouts])
```

### Convert PPTX to Images (requires LibreOffice or pdf2image)
```python
import subprocess
# Convert to PDF first, then to images
subprocess.run(["libreoffice", "--headless", "--convert-to", "pdf", "slides.pptx"])
from pdf2image import convert_from_path
images = convert_from_path("slides.pdf")
for i, img in enumerate(images):
    img.save(f"slide_{i+1}.png")
```

## Slide Layouts (default theme)

| Index | Name |
|-------|------|
| 0 | Title Slide |
| 1 | Title and Content |
| 2 | Title and Two Content |
| 5 | Title Only |
| 6 | Blank |

## Quick Reference

| Task | Method |
|------|--------|
| Add slide | `prs.slides.add_slide(layout)` |
| Title text | `slide.shapes.title.text` |
| Body text | `slide.placeholders[1].text_frame` |
| Add image | `slide.shapes.add_picture()` |
| Add table | `slide.shapes.add_table()` |
| Add textbox | `slide.shapes.add_textbox()` |
| Save | `prs.save("file.pptx")` |

Install: `pip install python-pptx`
