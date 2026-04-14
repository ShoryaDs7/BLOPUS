---
name: seo
description: Use this skill when the user wants SEO help — keyword research, meta tags, page optimization, competitor analysis, content briefs, backlink ideas, or analyzing a website's SEO.
---

# SEO Guide

## Keyword Research (Free Tools via Python)

### Get Google Autocomplete Suggestions
```python
import requests

def google_autocomplete(query: str) -> list:
    url = f"http://suggestqueries.google.com/complete/search?client=firefox&q={query}"
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"})
    suggestions = resp.json()[1]
    return suggestions

keywords = google_autocomplete("AI agents for")
for kw in keywords:
    print(kw)
```

### Get Related Keywords from Google
```python
import requests
from bs4 import BeautifulSoup

def get_related_searches(query: str) -> list:
    url = f"https://www.google.com/search?q={query.replace(' ', '+')}"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    resp = requests.get(url, headers=headers)
    soup = BeautifulSoup(resp.text, "html.parser")
    related = soup.find_all("div", {"class": "BNeawe"})
    return list(set([r.text for r in related if len(r.text) > 10]))[:10]
```

### Analyze Page SEO
```python
import requests
from bs4 import BeautifulSoup

def analyze_seo(url: str) -> dict:
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"})
    soup = BeautifulSoup(resp.text, "html.parser")

    title = soup.find("title")
    desc = soup.find("meta", attrs={"name": "description"})
    h1s = soup.find_all("h1")
    h2s = soup.find_all("h2")
    images = soup.find_all("img")
    imgs_no_alt = [img for img in images if not img.get("alt")]
    canonical = soup.find("link", attrs={"rel": "canonical"})
    og_title = soup.find("meta", attrs={"property": "og:title"})

    return {
        "title": title.text if title else "MISSING",
        "title_length": len(title.text) if title else 0,
        "meta_description": desc["content"] if desc else "MISSING",
        "meta_desc_length": len(desc["content"]) if desc else 0,
        "h1_count": len(h1s),
        "h1_text": [h.text.strip() for h in h1s],
        "h2_count": len(h2s),
        "images_total": len(images),
        "images_missing_alt": len(imgs_no_alt),
        "canonical": canonical["href"] if canonical else "MISSING",
        "og_title": og_title["content"] if og_title else "MISSING",
        "word_count": len(soup.get_text().split()),
    }

result = analyze_seo("https://example.com")
for key, val in result.items():
    print(f"{key}: {val}")
```

### Generate SEO Meta Tags
```python
def generate_meta_tags(title: str, description: str, keywords: list, url: str) -> str:
    if len(title) > 60:
        print(f"Warning: title is {len(title)} chars, should be under 60")
    if len(description) > 160:
        print(f"Warning: description is {len(description)} chars, should be under 160")

    tags = f"""<!-- SEO Meta Tags -->
<title>{title}</title>
<meta name="description" content="{description}">
<meta name="keywords" content="{', '.join(keywords)}">
<link rel="canonical" href="{url}">

<!-- Open Graph -->
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{url}">
<meta property="og:type" content="website">

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{description}">"""
    return tags

tags = generate_meta_tags(
    title="AI Agents for Social Media — Automate X, Reddit, Discord",
    description="Blopus is an open-source AI agent that posts as you on X, Reddit, and Discord. Learns your exact voice from your Twitter archive.",
    keywords=["AI agent", "social media automation", "Twitter bot", "autonomous agent"],
    url="https://yourdomain.com"
)
print(tags)
```

### Content Brief Generator
```python
import anthropic

def generate_content_brief(keyword: str) -> str:
    client = anthropic.Anthropic()
    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=800,
        messages=[{"role": "user", "content": f"""Create an SEO content brief for the keyword: "{keyword}"

Include:
1. Target keyword + 5 LSI keywords
2. Search intent (informational/commercial/transactional)
3. Recommended word count
4. H1 title (60 chars max)
5. Meta description (150 chars max)
6. H2 section headings (6-8)
7. Key points to cover in each section
8. Internal link opportunities
9. Call to action

Format as a clear brief a writer can follow."""}]
    )
    return msg.content[0].text

brief = generate_content_brief("AI social media automation")
print(brief)
```

### Check Competitor Keywords (via title scraping)
```python
import requests
from bs4 import BeautifulSoup

def competitor_analysis(url: str) -> dict:
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"})
    soup = BeautifulSoup(resp.text, "html.parser")

    title = soup.find("title").text if soup.find("title") else ""
    desc_tag = soup.find("meta", attrs={"name": "description"})
    desc = desc_tag["content"] if desc_tag else ""
    h1s = [h.text.strip() for h in soup.find_all("h1")]
    h2s = [h.text.strip() for h in soup.find_all("h2")]

    return {"url": url, "title": title, "description": desc, "h1": h1s, "h2": h2s}

competitors = [
    "https://competitor1.com",
    "https://competitor2.com"
]
for url in competitors:
    data = competitor_analysis(url)
    print(f"\n{data['url']}")
    print(f"Title: {data['title']}")
    print(f"H2s: {data['h2']}")
```

## SEO Checklist

| Item | Target |
|------|--------|
| Title length | 50-60 characters |
| Meta description | 140-160 characters |
| H1 count | Exactly 1 |
| H2 count | 3-8 per page |
| Word count | 1500+ for informational |
| Images with alt text | 100% |
| Page load speed | Under 3 seconds |
| Mobile-friendly | Yes |
| Canonical tag | Present |
| OG tags | Present |

Install: `pip install requests beautifulsoup4`
