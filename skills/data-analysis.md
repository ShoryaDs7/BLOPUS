---
name: data-analysis
description: Use this skill when the user wants to analyze CSV/Excel data, find insights, make charts or graphs, calculate statistics, filter/sort data, or visualize trends.
---

# Data Analysis Guide

## Quick Start

```python
import pandas as pd

df = pd.read_csv("data.csv")
print(df.head())
print(df.describe())
```

## Common Tasks

### Load and Explore Data
```python
import pandas as pd

df = pd.read_csv("data.csv")
print(df.shape)           # rows, columns
print(df.columns.tolist()) # column names
print(df.dtypes)          # data types
print(df.isnull().sum())  # missing values
print(df.describe())      # stats summary
```

### Filter and Sort
```python
# Filter rows
high_sales = df[df["Amount"] > 10000]

# Multiple conditions
filtered = df[(df["Amount"] > 5000) & (df["Category"] == "Tech")]

# Sort
df_sorted = df.sort_values("Amount", ascending=False)

# Top 10
top10 = df.nlargest(10, "Amount")
```

### Group and Aggregate
```python
# Sales by category
by_category = df.groupby("Category")["Amount"].sum().reset_index()
by_category.columns = ["Category", "Total"]

# Multiple aggregations
summary = df.groupby("Category").agg(
    Total=("Amount", "sum"),
    Count=("Amount", "count"),
    Average=("Amount", "mean")
).reset_index()
```

### Make a Bar Chart
```python
import matplotlib.pyplot as plt
import pandas as pd

df = pd.read_csv("data.csv")
summary = df.groupby("Category")["Amount"].sum()

plt.figure(figsize=(10, 6))
summary.plot(kind="bar", color="steelblue")
plt.title("Sales by Category")
plt.xlabel("Category")
plt.ylabel("Amount (Rs)")
plt.tight_layout()
plt.savefig("chart.png", dpi=150)
print("Chart saved as chart.png")
```

### Line Chart (Trend over Time)
```python
import matplotlib.pyplot as plt

df["Date"] = pd.to_datetime(df["Date"])
df_sorted = df.sort_values("Date")
monthly = df_sorted.groupby(df_sorted["Date"].dt.to_period("M"))["Amount"].sum()

plt.figure(figsize=(12, 5))
monthly.plot(kind="line", marker="o")
plt.title("Monthly Revenue Trend")
plt.tight_layout()
plt.savefig("trend.png", dpi=150)
```

### Pie Chart
```python
import matplotlib.pyplot as plt

breakdown = df.groupby("Category")["Amount"].sum()
plt.figure(figsize=(8, 8))
breakdown.plot(kind="pie", autopct="%1.1f%%")
plt.title("Revenue Breakdown")
plt.tight_layout()
plt.savefig("pie.png", dpi=150)
```

### Find Correlations
```python
correlation = df[["Sales", "Profit", "Discount"]].corr()
print(correlation)
```

### Export Results
```python
# To CSV
summary.to_csv("results.csv", index=False)

# To Excel with multiple sheets
with pd.ExcelWriter("report.xlsx") as writer:
    df.to_excel(writer, sheet_name="Raw Data", index=False)
    summary.to_excel(writer, sheet_name="Summary", index=False)
```

### Full Analysis Pipeline
```python
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("sales.csv")

# Clean
df = df.dropna()
df["Amount"] = pd.to_numeric(df["Amount"], errors="coerce")

# Analyze
total = df["Amount"].sum()
avg = df["Amount"].mean()
top_cat = df.groupby("Category")["Amount"].sum().idxmax()

print(f"Total Revenue: Rs. {total:,.0f}")
print(f"Average Order: Rs. {avg:,.0f}")
print(f"Top Category: {top_cat}")

# Chart
df.groupby("Category")["Amount"].sum().plot(kind="bar")
plt.tight_layout()
plt.savefig("analysis.png", dpi=150)
print("Saved analysis.png")
```

## Quick Reference

| Task | Method |
|------|--------|
| Load CSV | `pd.read_csv()` |
| Load Excel | `pd.read_excel()` |
| Filter | `df[df["col"] > value]` |
| Group | `df.groupby("col").sum()` |
| Charts | `matplotlib.pyplot` |
| Export | `.to_csv()` / `.to_excel()` |

Install: `pip install pandas matplotlib openpyxl`
