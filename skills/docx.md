---
name: docx
description: Use this skill whenever the user wants to do anything with Word (.docx) files. This includes reading or extracting text from Word documents, creating new Word documents, editing content, formatting (bold, italic, headings, tables, lists), adding images, headers/footers, and converting to/from other formats.
---

# Word Document Processing Guide

## Quick Start

```python
from docx import Document

doc = Document("document.docx")
for para in doc.paragraphs:
    print(para.text)
```

## Common Tasks

### Read Text from DOCX
```python
from docx import Document

doc = Document("document.docx")
text = "\n".join([para.text for para in doc.paragraphs])
print(text)
```

### Create a New DOCX
```python
from docx import Document
from docx.shared import Pt

doc = Document()
doc.add_heading("My Document", 0)
doc.add_paragraph("This is a paragraph.")
doc.add_paragraph("Bold text here.", style="Normal").runs[0].bold = True
doc.save("output.docx")
```

### Add Table
```python
from docx import Document

doc = Document()
table = doc.add_table(rows=3, cols=3)
table.style = "Table Grid"
for i, row in enumerate(table.rows):
    for j, cell in enumerate(row.cells):
        cell.text = f"Row {i}, Col {j}"
doc.save("table.docx")
```

### Format Text
```python
from docx import Document
from docx.shared import Pt, RGBColor

doc = Document()
para = doc.add_paragraph()
run = para.add_run("Formatted text")
run.bold = True
run.italic = True
run.font.size = Pt(14)
run.font.color.rgb = RGBColor(0xFF, 0x00, 0x00)  # Red
doc.save("formatted.docx")
```

### Add Heading Levels
```python
doc.add_heading("Heading 1", level=1)
doc.add_heading("Heading 2", level=2)
doc.add_heading("Heading 3", level=3)
```

### Add Bullet List
```python
doc.add_paragraph("Item one", style="List Bullet")
doc.add_paragraph("Item two", style="List Bullet")
doc.add_paragraph("Numbered item", style="List Number")
```

### Extract Tables
```python
from docx import Document

doc = Document("document.docx")
for table in doc.tables:
    for row in table.rows:
        for cell in row.cells:
            print(cell.text, end="\t")
        print()
```

### Add Header and Footer
```python
from docx import Document
from docx.oxml.ns import qn

doc = Document()
section = doc.sections[0]
header = section.header
header.paragraphs[0].text = "My Header"
footer = section.footer
footer.paragraphs[0].text = "Page footer"
doc.save("with_header.docx")
```

## Quick Reference

| Task | Method |
|------|--------|
| Read text | `doc.paragraphs` |
| Add paragraph | `doc.add_paragraph()` |
| Add heading | `doc.add_heading()` |
| Add table | `doc.add_table()` |
| Bold/italic | `run.bold`, `run.italic` |
| Font size | `run.font.size = Pt(N)` |
| Save | `doc.save("file.docx")` |

Install: `pip install python-docx`
