/**
 * DiscordServerJoiner — Auto-joins Discord servers based on user's dominant topics.
 * Strategy:
 *  1. Capture user auth token by intercepting Discord API requests on page load
 *  2. Search discoverable guilds via Discord's own search API (same endpoint discord.com/servers uses)
 *  3. Use vanity_url_code (returned in search results) as the invite code
 *  4. Join via POST /api/v9/invites/{code} with proper headers — same as Discord client does
 */

import fs from 'fs'
import path from 'path'
import type { DiscordAdapter } from './index'

async function captureAuthToken(page: import('playwright').Page): Promise<string | null> {
  let capturedToken: string | null = null

  const requestHandler = (request: import('playwright').Request) => {
    const auth = request.headers()['authorization']
    if (auth && request.url().includes('discord.com/api/')) {
      capturedToken = auth
    }
  }
  page.on('request', requestHandler)

  await page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('[data-list-id="guildsnav"]', { timeout: 20000 }).catch(() => {
    console.warn('[DiscordJoiner] Guild nav not found — may not be logged in')
  })
  await page.waitForTimeout(3000)
  page.off('request', requestHandler)

  return capturedToken
}

async function searchDiscoverableGuilds(
  page: import('playwright').Page,
  keyword: string,
  token: string,
): Promise<Array<{ id: string; name: string; invite_code: string | null }>> {
  // Discord's discovery search — same endpoint discord.com/servers uses internally
  const result = await page.evaluate(
    async (params: { keyword: string; token: string }) => {
      try {
        // First try the authenticated search endpoint
        const resp = await fetch(
          `https://discord.com/api/v9/discoverable-guilds/search?query=${encodeURIComponent(params.keyword)}&limit=25`,
          {
            headers: {
              Authorization: params.token,
              'X-Discord-Locale': 'en-US',
            },
          },
        )
        if (resp.ok) {
          const data = await resp.json()
          return { ok: true, data, endpoint: 'GET /discoverable-guilds/search' }
        }
        // Fallback: unauthenticated discoverable-guilds (returns curated list, filter by keyword)
        const resp2 = await fetch(
          `https://discord.com/api/v9/discoverable-guilds?limit=48`,
          { headers: { Authorization: params.token } },
        )
        if (resp2.ok) {
          const data2 = await resp2.json()
          return { ok: true, data: data2, endpoint: 'GET /discoverable-guilds', fallback: true, keyword: params.keyword }
        }
        const errText = await resp.text().catch(() => '')
        return { ok: false, status: resp.status, error: errText }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
    { keyword, token },
  )

  console.log(`[DiscordJoiner] Search (${keyword}):`, JSON.stringify(result).slice(0, 200))

  if (!result.ok || !result.data) return []

  const data = result.data as Record<string, unknown>
  let guilds: Array<Record<string, unknown>> = []

  if (Array.isArray(data)) {
    guilds = data
  } else if (Array.isArray((data as Record<string, unknown>).guilds)) {
    guilds = (data as Record<string, unknown>).guilds as Array<Record<string, unknown>>
  }

  // If fallback, filter by keyword
  if ((result as Record<string, unknown>).fallback) {
    const kw = keyword.toLowerCase()
    guilds = guilds.filter(g => {
      const name = String(g.name ?? '').toLowerCase()
      const desc = String(g.description ?? '').toLowerCase()
      return name.includes(kw) || desc.includes(kw)
    })
  }

  return guilds.map(g => ({
    id: String(g.id ?? ''),
    name: String(g.name ?? ''),
    // vanity_url_code IS the invite code — returned directly in discovery results
    invite_code: (g.vanity_url_code as string | null) ?? null,
  }))
}

async function joinViaCompass(
  page: import('playwright').Page,
  keyword: string,
): Promise<Array<{ guildId: string; name: string }>> {
  const joined: Array<{ guildId: string; name: string }> = []
  try {
    // Go to discord.com/app first to be in the SPA context
    const isOnApp = page.url().includes('discord.com')
    if (!isOnApp) {
      await page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(2000)
    }

    // Click the Explore Public Servers compass icon in the guild sidebar
    const compass = page.locator('[data-list-id="guildsnav"] [aria-label="Explore Discoverable Servers"], [aria-label="Explore Public Servers"]').first()
    const compassVisible = await compass.isVisible().catch(() => false)
    if (compassVisible) {
      await compass.click()
    } else {
      // Fallback: navigate directly to the discovery URL
      await page.goto('https://discord.com/guild-discovery', { waitUntil: 'domcontentloaded', timeout: 15000 })
    }
    await page.waitForTimeout(2000)

    // Click the search icon to open the search field, then type keyword
    const searchIcon = page.locator('[aria-label="Search"], button[class*="search"], [class*="searchIcon"]').first()
    const iconVisible = await searchIcon.isVisible().catch(() => false)
    if (iconVisible) await searchIcon.click()
    await page.waitForTimeout(500)

    const searchBox = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]').first()
    const searchVisible = await searchBox.isVisible().catch(() => false)
    if (searchVisible) {
      await searchBox.fill(keyword)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(2000)
    } else {
      console.warn(`[DiscordJoiner] Search box not found for "${keyword}"`)
    }

    await page.screenshot({ path: `./memory-store/compass-search-${keyword}.png` }).catch(() => {})

    // Click up to 3 server name headings — Discord's class names are obfuscated so target h3 directly
    const serverNames = await page.locator('h3').all().catch(() => [])
    let attempted = 0
    for (const nameEl of serverNames.slice(0, 5)) {
      if (attempted >= 3) break
      try {
        const name = await nameEl.innerText().catch(() => '')
        if (!name) continue

        await nameEl.click()
        await page.waitForTimeout(3000)

        // In preview mode, the Join button appears at the top: "Join [Server Name]"
        // It contains "Join" text — use partial match
        const joinBtn = page.locator('button').filter({ hasText: /^Join/ }).first()
        const joinVisible = await joinBtn.isVisible().catch(() => false)
        if (!joinVisible) {
          await page.goBack().catch(() => {})
          await page.waitForTimeout(1500)
          continue
        }

        await joinBtn.click()
        await page.waitForTimeout(3000)

        // Handle onboarding questions — skip if optional, click first answer if required
        for (let step = 0; step < 10; step++) {
          const skipBtn = page.locator('text=Skip').first()
          const skipVisible = await skipBtn.isVisible().catch(() => false)

          const isRequired = await page.locator('text=Required').isVisible().catch(() => false)

          if (isRequired || !skipVisible) {
            // Click the first available answer option
            const firstOption = page.locator('[class*="option"], [class*="answer"], [class*="choice"], label, li').first()
            const optionVisible = await firstOption.isVisible().catch(() => false)
            if (optionVisible) {
              await firstOption.click()
              await page.waitForTimeout(500)
              // Then try to find a Next/Continue/Submit button
              const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), button:has-text("Submit"), button:has-text("Finish")').first()
              const nextVisible = await nextBtn.isVisible().catch(() => false)
              if (nextVisible) {
                await nextBtn.click()
                await page.waitForTimeout(1500)
                continue
              }
            }
          }

          if (skipVisible) {
            await skipBtn.click()
            await page.waitForTimeout(1500)
          } else {
            break
          }
        }

        const urlAfter = page.url()
        const match = urlAfter.match(/channels\/(\d{15,})/)
        const guildId = match ? match[1] : `compass_${Date.now()}`
        console.log(`[DiscordJoiner] ✓ Joined: ${name} (${guildId})`)
        joined.push({ guildId, name })
        attempted++

        // Go back to search results for next server
        await page.goto(`https://discord.com/guild-discovery`, { waitUntil: 'domcontentloaded', timeout: 15000 })
        await page.waitForTimeout(1500)
        const sb = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first()
        if (await sb.isVisible().catch(() => false)) {
          await sb.fill(keyword)
          await page.keyboard.press('Enter')
          await page.waitForTimeout(2000)
        }
      } catch { /* skip card */ }
    }
  } catch (err) {
    console.warn(`[DiscordJoiner] Compass join failed for "${keyword}":`, err)
  }
  return joined
}

// Servers that need manual onboarding (captcha blocked) — reported at end
const manualOnboardingNeeded: Array<{ name: string; url: string }> = []

export function getManualOnboardingList() { return manualOnboardingNeeded }

// Returns true if fully inside server, false if onboarding needed
async function completeOnboarding(page: import('playwright').Page, guildName: string): Promise<boolean> {
  await page.waitForTimeout(2000)
  const url = page.url()

  // Fully inside — no onboarding
  const inPreviewMode = await page.locator('text=/preview mode/i').isVisible().catch(() => false)
  if (!inPreviewMode && /channels\/\d{15,}\/\d{15,}/.test(url)) {
    return true
  }

  // Onboarding required — tell user to complete it
  const onboardingUrl = url.includes('/onboarding') ? url : `https://discord.com/channels/${url.match(/channels\/(\d{15,})/)?.[1]}/onboarding`
  console.warn(`[DiscordJoiner] ⚠️  "${guildName}" — clicked Join but needs YOUR onboarding to finish`)
  console.warn(`[DiscordJoiner] 👉 Complete here: ${onboardingUrl}`)
  manualOnboardingNeeded.push({ name: guildName, url: onboardingUrl })
  return false
}

async function joinViaDiscovery(
  page: import('playwright').Page,
  guildName: string,
  keyword: string,
): Promise<boolean> {
  try {
    // Open guild-discovery and search
    await page.goto('https://discord.com/guild-discovery', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(2000)

    // Click search icon, type keyword
    await page.locator('[aria-label="Search"], [class*="searchIcon"], svg[class*="search"]').first().click().catch(() => {})
    await page.waitForTimeout(500)
    const searchBox = page.locator('input').filter({ hasNot: page.locator('input[type="hidden"]') }).first()
    await searchBox.fill(keyword)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)

    // Click the server card by finding its text in the DOM, excluding the guild nav sidebar
    const clicked = await page.evaluate(`
      (() => {
        const name = ${JSON.stringify(guildName)}
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          if (node.textContent?.trim() === name) {
            const parent = node.parentElement
            if (parent && !parent.closest('[data-list-item-id^="guildsnav"]')) {
              parent.click()
              return true
            }
          }
        }
        return false
      })()
    `) as boolean

    if (!clicked) {
      console.warn(`[DiscordJoiner] Server "${guildName}" not found in discovery results`)
      return false
    }
    await page.waitForTimeout(3000)

    // Purple join banner: "Join [Server Name]"
    const joinBtn = page.locator('button').filter({ hasText: /^Join/ }).first()
    const joinVisible = await joinBtn.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
    if (!joinVisible) {
      console.warn(`[DiscordJoiner] No join button after clicking "${guildName}"`)
      return false
    }

    await joinBtn.click()
    await page.waitForTimeout(3000)

    const fullyJoined = await completeOnboarding(page, guildName)
    if (fullyJoined) {
      console.log(`[DiscordJoiner] ✓ Joined: ${guildName}`)
    }
    return fullyJoined
  } catch (err) {
    console.warn(`[DiscordJoiner] Discovery join failed for ${guildName}:`, err)
    return false
  }
}

async function joinViaInvite(
  page: import('playwright').Page,
  inviteCode: string,
  token: string,
): Promise<{ ok: boolean; guildId?: string; alreadyMember?: boolean; error?: string }> {
  return page.evaluate(
    async (params: { inviteCode: string; token: string }) => {
      try {
        // Step 1: get invite metadata (guild_id, channel_id for X-Context-Properties)
        const infoResp = await fetch(
          `https://discord.com/api/v9/invites/${params.inviteCode}?with_counts=true&with_expiration=true`,
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const infoData: any = infoResp.ok ? await infoResp.json() : null
        const guildId = infoData?.guild?.id ?? ''
        const channelId = infoData?.channel?.id ?? ''
        const channelType = infoData?.channel?.type ?? 0

        const contextProps = btoa(JSON.stringify({
          location: 'Join Guild',
          guild_id: guildId,
          channel_id: channelId,
          channel_type: channelType,
        }))

        // Step 2: join the guild
        const resp = await fetch(`https://discord.com/api/v9/invites/${params.inviteCode}`, {
          method: 'POST',
          headers: {
            Authorization: params.token,
            'Content-Type': 'application/json',
            'X-Context-Properties': contextProps,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
          body: JSON.stringify({}),
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await resp.json().catch(() => ({}))
        if (resp.ok) {
          return { ok: true, guildId: data?.guild?.id ?? guildId }
        }
        // code 50013 = already a member
        if (data?.code === 50013) {
          return { ok: true, alreadyMember: true, guildId }
        }
        return { ok: false, error: JSON.stringify(data).slice(0, 200) }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
    { inviteCode, token },
  )
}

async function searchAndJoinDiscordServers(
  page: import('playwright').Page,
  keyword: string,
  token: string,
  target = 5,
): Promise<Array<{ name: string; guildId: string }>> {
  try {
    console.log(`[DiscordJoiner] Searching for: "${keyword}"`)
    const guilds = await searchDiscoverableGuilds(page, keyword, token)
    console.log(`[DiscordJoiner] Found ${guilds.length} servers for "${keyword}"`)

    if (guilds.length === 0) return []

    const joined: Array<{ name: string; guildId: string }> = []

    for (const guild of guilds.slice(0, 15)) {
      if (joined.length >= target) break
      if (joined.some(j => j.guildId === guild.id)) continue

      let didJoin = false

      try {
        const inviteCode = guild.invite_code
        if (inviteCode) {
          const result = await joinViaInvite(page, inviteCode, token)
          if (result.ok) {
            const fullyJoined = await completeOnboarding(page, guild.name)
            if (fullyJoined) {
              console.log(`[DiscordJoiner] ✓ [${joined.length + 1}/${target}] Joined via invite: ${guild.name}`)
              joined.push({ name: guild.name, guildId: result.guildId ?? guild.id })
              didJoin = true
            }
          }
        }

        if (!didJoin && !page.isClosed()) {
          const ok = await joinViaDiscovery(page, guild.name, keyword)
          if (ok) {
            console.log(`[DiscordJoiner] ✓ [${joined.length + 1}/${target}] Joined via discovery: ${guild.name}`)
            joined.push({ name: guild.name, guildId: guild.id })
          }
        }
      } catch (err) {
        console.warn(`[DiscordJoiner] Failed "${guild.name}": ${String(err).slice(0, 80)}`)
      }

      await new Promise(r => setTimeout(r, 5000))
    }

    return joined
  } catch (err) {
    console.warn(`[DiscordJoiner] Error for "${keyword}":`, err)
    return []
  }
}

export async function autoJoinServers(
  discord: DiscordAdapter,
  dominantTopics: string[],
  configDir: string,
): Promise<string[]> {
  const cacheFile = path.join(configDir, 'discord_guilds.json')
  const TARGET_PER_TOPIC = 5

  // Cache only holds FULLY joined IDs (onboarding complete)
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
    const ids: string[] = cached.guildIds ?? cached
    const savedAt: number = cached.savedAt ?? 0
    const ageDays = (Date.now() - savedAt) / 86400000
    if (ids.length > 0 && ageDays < 7) {
      console.log(`[DiscordJoiner] Loaded ${ids.length} fully-joined guild IDs from cache.`)
      return ids
    }
  }

  const page = discord.getPage()
  if (!page) {
    console.warn('[DiscordJoiner] No browser page available.')
    return []
  }

  const token = await captureAuthToken(page)
  if (!token) {
    console.warn('[DiscordJoiner] Could not capture auth token — are you logged in?')
    return []
  }
  console.log('[DiscordJoiner] Auth token captured.')

  const allJoinedIds: string[] = []

  for (const topic of dominantTopics.slice(0, 3)) {
    const keyword = topic.split(/\s+/).find(w => w.length >= 4) ?? topic
    console.log(`\n[DiscordJoiner] Topic: "${keyword}" — target ${TARGET_PER_TOPIC} fully joined servers`)

    // searchAndJoinDiscordServers already handles invite + discovery fallback per guild
    // Pass target so it stops at 5 per topic
    const joined = await searchAndJoinDiscordServers(page, keyword, token, TARGET_PER_TOPIC)
    for (const s of joined) {
      if (!allJoinedIds.includes(s.guildId)) allJoinedIds.push(s.guildId)
    }
    console.log(`[DiscordJoiner] Topic "${keyword}": ${joined.length}/${TARGET_PER_TOPIC} fully joined`)
  }

  if (allJoinedIds.length > 0) {
    fs.writeFileSync(cacheFile, JSON.stringify({ guildIds: allJoinedIds, savedAt: Date.now() }, null, 2))
    console.log(`[DiscordJoiner] Saved ${allJoinedIds.length} fully-joined guild IDs.`)
  } else {
    console.warn('[DiscordJoiner] Could not fully join any servers. Set DISCORD_GUILD_IDS manually in .env.')
  }

  console.log('\n========== DISCORD JOIN SUMMARY ==========')
  console.log(`✓ Fully joined: ${allJoinedIds.length} server(s)`)
  if (manualOnboardingNeeded.length > 0) {
    console.log(`\n⚠️  ${manualOnboardingNeeded.length} server(s) need YOUR onboarding (open these links):`)
    for (const m of manualOnboardingNeeded) {
      console.log(`   → ${m.name}`)
      console.log(`     Open: ${m.url}`)
    }
    console.log('\n   Complete onboarding, run again — they will count toward the 5 target.')
  }
  console.log('==========================================\n')

  return allJoinedIds
}
