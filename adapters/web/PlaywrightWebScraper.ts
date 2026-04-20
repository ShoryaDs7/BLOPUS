/**
 * PlaywrightWebScraper — generic form-fill + full-page scraper.
 *
 * Takes any URL + a map of field labels/names to values,
 * fills and submits the form, then clicks through every
 * tab/section it finds and returns all extracted text.
 */

import { chromium, Browser, Page } from 'playwright'

export interface ScrapeField {
  label: string   // visible label OR input name/placeholder
  value: string
}

export interface ScrapeSection {
  title: string
  content: string
}

export interface ScrapeResult {
  url: string
  sections: ScrapeSection[]
  rawText: string
  error?: string
}

export class PlaywrightWebScraper {
  private browser: Browser | null = null

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true })
    }
    return this.browser
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }

  // ── Main entry point ──────────────────────────────────────────
  async scrape(url: string, fields: ScrapeField[]): Promise<ScrapeResult> {
    const browser = await this.getBrowser()
    const page = await browser.newPage()

    try {
      console.log(`[WebScraper] Navigating to ${url}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(2000)

      // Fill each field
      for (const field of fields) {
        await this.fillField(page, field)
      }

      // Submit the form
      if (fields.length > 0) {
        await this.submitForm(page)
        console.log(`[WebScraper] Form submitted — waiting for results...`)
        await page.waitForTimeout(3000)
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      }

      // Scrape all tabs/sections
      const sections = await this.scrapeAllSections(page)
      const rawText = sections.map(s => `=== ${s.title} ===\n${s.content}`).join('\n\n')

      console.log(`[WebScraper] Done — ${sections.length} sections extracted`)
      return { url, sections, rawText }

    } catch (err: any) {
      console.log(`[WebScraper] Error: ${err.message}`)
      return { url, sections: [], rawText: '', error: err.message }
    } finally {
      await page.close()
    }
  }

  // ── Fill one field by label / name / placeholder ──────────────
  private async fillField(page: Page, field: ScrapeField): Promise<void> {
    const label = field.label.toLowerCase().trim()
    const value = field.value

    try {
      // Strategy 1: find <label> with matching text, then fill its input
      const labelEl = page.locator(`label`).filter({ hasText: new RegExp(label, 'i') }).first()
      const labelCount = await labelEl.count()
      if (labelCount > 0) {
        const forAttr = await labelEl.getAttribute('for')
        if (forAttr) {
          const input = page.locator(`#${forAttr}`)
          const tag = await input.evaluate((el: Element) => el.tagName.toLowerCase()).catch(() => '')
          if (tag === 'select') {
            await input.selectOption({ label: value }).catch(() => input.selectOption(value))
          } else {
            await input.fill(value)
          }
          console.log(`[WebScraper] Filled "${field.label}" via label`)
          return
        }
      }

      // Strategy 2: find input by name / placeholder / aria-label
      const selectors = [
        `input[name="${label}"]`,
        `input[placeholder*="${label}" i]`,
        `input[aria-label*="${label}" i]`,
        `select[name="${label}"]`,
        `textarea[name="${label}"]`,
        `textarea[placeholder*="${label}" i]`,
      ]
      for (const sel of selectors) {
        const el = page.locator(sel).first()
        if (await el.count() > 0) {
          const tag = await el.evaluate((e: Element) => e.tagName.toLowerCase()).catch(() => 'input')
          if (tag === 'select') {
            await el.selectOption({ label: value }).catch(() => el.selectOption(value))
          } else {
            await el.fill(value)
          }
          console.log(`[WebScraper] Filled "${field.label}" via selector ${sel}`)
          return
        }
      }

      // Strategy 3: autocomplete location fields (type + pick first suggestion)
      const locationInput = page.locator(`input[placeholder*="place" i], input[placeholder*="location" i], input[placeholder*="city" i]`).first()
      if (await locationInput.count() > 0) {
        await locationInput.fill(value)
        await page.waitForTimeout(1500)
        const suggestion = page.locator(`[class*="suggestion" i], [class*="autocomplete" i], [class*="dropdown" i] li`).first()
        if (await suggestion.count() > 0) {
          await suggestion.click()
          console.log(`[WebScraper] Filled location "${field.label}" via autocomplete`)
          return
        }
      }

      console.log(`[WebScraper] Could not find field: "${field.label}"`)
    } catch (err: any) {
      console.log(`[WebScraper] Error filling "${field.label}": ${err.message}`)
    }
  }

  // ── Submit the form ───────────────────────────────────────────
  private async submitForm(page: Page): Promise<void> {
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Generate")',
      'button:has-text("Submit")',
      'button:has-text("Calculate")',
      'button:has-text("Search")',
      'button:has-text("Get")',
      'button:has-text("Check")',
      'button:has-text("View")',
      'button:has-text("Show")',
    ]
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first()
      if (await btn.count() > 0) {
        await btn.click()
        console.log(`[WebScraper] Clicked submit: ${sel}`)
        return
      }
    }
    // Fallback: press Enter on last filled input
    await page.keyboard.press('Enter')
    console.log(`[WebScraper] Submit via Enter key`)
  }

  // ── Click every tab/section and extract text ──────────────────
  private async scrapeAllSections(page: Page): Promise<ScrapeSection[]> {
    const sections: ScrapeSection[] = []
    const visitedTitles = new Set<string>()

    // Find all clickable tabs
    const tabSelectors = [
      '[role="tab"]',
      '[class*="tab" i]:not(input):not(textarea)',
      'nav a',
      '[class*="menu-item" i]',
      '[class*="nav-item" i]',
      'ul[class*="tab" i] li',
      'ul[class*="nav" i] li a',
    ]

    let tabs: string[] = []
    for (const sel of tabSelectors) {
      const els = await page.locator(sel).all()
      for (const el of els) {
        const text = (await el.textContent() ?? '').trim()
        if (text && text.length > 1 && text.length < 60 && !visitedTitles.has(text)) {
          tabs.push(text)
        }
      }
      if (tabs.length > 0) break
    }

    if (tabs.length === 0) {
      // No tabs — just scrape the full page
      const content = await this.extractPageText(page)
      sections.push({ title: 'Main', content })
      return sections
    }

    console.log(`[WebScraper] Found ${tabs.length} tabs: ${tabs.slice(0, 8).join(', ')}`)

    // Click each tab and extract
    for (const tabText of tabs) {
      if (visitedTitles.has(tabText)) continue
      visitedTitles.add(tabText)

      try {
        // Find and click the tab
        for (const sel of tabSelectors) {
          const tab = page.locator(sel).filter({ hasText: new RegExp(`^${tabText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).first()
          if (await tab.count() > 0) {
            await tab.click()
            await page.waitForTimeout(1500)
            await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
            break
          }
        }

        const content = await this.extractPageText(page)
        if (content.trim().length > 50) {
          sections.push({ title: tabText, content })
          console.log(`[WebScraper] Extracted tab "${tabText}" — ${content.length} chars`)
        }
      } catch (err: any) {
        console.log(`[WebScraper] Could not click tab "${tabText}": ${err.message}`)
      }
    }

    // If no tabs worked, fall back to full page
    if (sections.length === 0) {
      const content = await this.extractPageText(page)
      sections.push({ title: 'Main', content })
    }

    return sections
  }

  // ── Extract all meaningful text from current page state ───────
  private async extractPageText(page: Page): Promise<string> {
    return page.evaluate(() => {
      // Remove noise elements
      const noise = ['script', 'style', 'nav', 'header', 'footer', '[class*="ad" i]', '[class*="banner" i]']
      noise.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove())
      })

      // Extract tables properly
      const tables: string[] = []
      document.querySelectorAll('table').forEach(table => {
        const rows: string[] = []
        table.querySelectorAll('tr').forEach(row => {
          const cells = Array.from(row.querySelectorAll('th, td')).map(c => c.textContent?.trim() ?? '')
          if (cells.some(c => c)) rows.push(cells.join(' | '))
        })
        if (rows.length > 0) tables.push(rows.join('\n'))
      })

      // Extract headings + paragraphs
      const textParts: string[] = []
      document.querySelectorAll('h1, h2, h3, h4, p, li, td, th, [class*="value" i], [class*="result" i], [class*="data" i]').forEach(el => {
        const text = el.textContent?.trim() ?? ''
        if (text.length > 2 && text.length < 500) {
          textParts.push(text)
        }
      })

      return [...tables, ...textParts]
        .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
        .join('\n')
    })
  }
}
