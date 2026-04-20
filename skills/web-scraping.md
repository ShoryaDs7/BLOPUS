---
name: web-scraping
description: Use this skill when the user wants to extract data from any website, scrape product prices, get article text, monitor pages, download links, or automate web data collection.
---

# Web Scraping Guide

## Quick Start

```python
import requests
from bs4 import BeautifulSoup

resp = requests.get("https://example.com", headers={"User-Agent": "Mozilla/5.0"})
soup = BeautifulSoup(resp.text, "html.parser")
print(soup.find("h1").text)
```

## Common Tasks

### Scrape All Links from a Page
```python
import requests
from bs4 import BeautifulSoup

resp = requests.get("https://example.com", headers={"User-Agent": "Mozilla/5.0"})
soup = BeautifulSoup(resp.text, "html.parser")
links = [a["href"] for a in soup.find_all("a", href=True)]
for link in links:
    print(link)
```

### Scrape Product Price
```python
import requests
from bs4 import BeautifulSoup

url = "https://example-shop.com/product"
resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"})
soup = BeautifulSoup(resp.text, "html.parser")
price = soup.find(class_="price").text.strip()
print(f"Price: {price}")
```

### Scrape Table Data
```python
import requests
import pandas as pd

url = "https://example.com/table-page"
tables = pd.read_html(url)
df = tables[0]  # First table
df.to_csv("scraped_table.csv", index=False)
print(df.head())
```

### Scrape Multiple Pages (Pagination)
```python
import requests
from bs4 import BeautifulSoup
import time

results = []
for page in range(1, 6):  # Pages 1-5
    url = f"https://example.com/items?page={page}"
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"})
    soup = BeautifulSoup(resp.text, "html.parser")
    items = soup.find_all(class_="item-title")
    results.extend([i.text.strip() for i in items])
    time.sleep(1)  # Be polite

print(f"Total items: {len(results)}")
```

### JavaScript-rendered Pages (use Playwright)
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto("https://example.com")
    page.wait_for_selector(".content")
    content = page.inner_text(".content")
    browser.close()
print(content)
```

### Save Scraped Data to JSON
```python
import json

data = [{"title": "Item 1", "price": "100"}, {"title": "Item 2", "price": "200"}]
with open("scraped.json", "w") as f:
    json.dump(data, f, indent=2)
```

### Monitor a Page for Changes
```python
import requests, hashlib, time

url = "https://example.com"
last_hash = ""
while True:
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"})
    current_hash = hashlib.md5(resp.text.encode()).hexdigest()
    if current_hash != last_hash:
        print(f"PAGE CHANGED at {__import__('datetime').datetime.now()}")
        last_hash = current_hash
    time.sleep(300)  # Check every 5 minutes
```

## Quick Reference

| Task | Tool |
|------|------|
| Static HTML | requests + BeautifulSoup |
| Tables | pandas read_html |
| JS sites | playwright |
| Large crawls | scrapy |

Install: `pip install requests beautifulsoup4 pandas playwright`
For playwright: `playwright install chromium`
