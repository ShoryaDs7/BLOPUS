---
name: xlsx
description: Use this skill whenever the user wants to do anything with Excel (.xlsx) files. This includes reading or writing spreadsheets, creating/editing cells, formatting, formulas, charts, pivot tables, filtering, sorting, and converting between Excel and CSV/JSON.
---

# Excel Spreadsheet Processing Guide

## Quick Start

```python
import openpyxl

wb = openpyxl.load_workbook("data.xlsx")
ws = wb.active
for row in ws.iter_rows(values_only=True):
    print(row)
```

## Common Tasks

### Read Excel File
```python
import openpyxl

wb = openpyxl.load_workbook("data.xlsx")
ws = wb.active
for row in ws.iter_rows(min_row=1, values_only=True):
    print(row)
```

### Read with pandas (easier for data work)
```python
import pandas as pd

df = pd.read_excel("data.xlsx", sheet_name="Sheet1")
print(df.head())
print(df.describe())
```

### Write Excel File
```python
import openpyxl

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "My Sheet"
ws["A1"] = "Name"
ws["B1"] = "Score"
ws.append(["Alice", 95])
ws.append(["Bob", 87])
wb.save("output.xlsx")
```

### Write with pandas
```python
import pandas as pd

data = {"Name": ["Alice", "Bob"], "Score": [95, 87]}
df = pd.DataFrame(data)
df.to_excel("output.xlsx", index=False)
```

### Multiple Sheets
```python
import openpyxl

wb = openpyxl.Workbook()
ws1 = wb.active
ws1.title = "Sheet1"
ws2 = wb.create_sheet("Sheet2")
ws1["A1"] = "First sheet"
ws2["A1"] = "Second sheet"
wb.save("multi_sheet.xlsx")
```

### Cell Formatting
```python
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

ws["A1"].font = Font(bold=True, size=14, color="FF0000")
ws["A1"].fill = PatternFill("solid", fgColor="FFFF00")
ws["A1"].alignment = Alignment(horizontal="center")
```

### Add Formula
```python
ws["C1"] = "Total"
ws["C2"] = "=SUM(B2:B10)"
ws["C3"] = "=AVERAGE(B2:B10)"
```

### Auto-fit Column Width
```python
for col in ws.columns:
    max_len = max(len(str(cell.value or "")) for cell in col)
    ws.column_dimensions[get_column_letter(col[0].column)].width = max_len + 2
```

### Filter and Sort with pandas
```python
import pandas as pd

df = pd.read_excel("data.xlsx")
filtered = df[df["Score"] > 80].sort_values("Score", ascending=False)
filtered.to_excel("filtered.xlsx", index=False)
```

### Convert Excel to CSV
```python
import pandas as pd

df = pd.read_excel("data.xlsx")
df.to_csv("data.csv", index=False)
```

### Convert CSV to Excel
```python
import pandas as pd

df = pd.read_csv("data.csv")
df.to_excel("data.xlsx", index=False)
```

## Quick Reference

| Task | Best Tool |
|------|-----------|
| Read/write basic | openpyxl |
| Data analysis | pandas |
| Formatting | openpyxl styles |
| Formulas | openpyxl (`=SUM(...)`) |
| Multiple sheets | openpyxl |
| CSV conversion | pandas |

Install: `pip install openpyxl pandas`
