// Blopus Intent — content script
// Detects compose intent signals and sends them to localhost:3847/intent

const BLOPUS_PORT = 3847

// Ghost compose tracking only makes sense on sites where you actually write messages
const COMPOSE_HOSTS = [
  'mail.google.com', 'gmail.com',
  'x.com', 'twitter.com',
  'linkedin.com',
  'reddit.com',
  'outlook.live.com', 'outlook.office.com',
  'notion.so',
  'slack.com',
]

function isComposeHost() {
  try {
    const host = new URL(location.href).hostname
    return COMPOSE_HOSTS.some(h => host.endsWith(h))
  } catch { return false }
}

function getPlatform(url) {
  try {
    const h = new URL(url).hostname
    if (h.includes('x.com') || h.includes('twitter.com')) return 'twitter'
    if (h.includes('gmail.com') || h.includes('mail.google.com')) return 'gmail'
    if (h.includes('linkedin.com')) return 'linkedin'
    if (h.includes('reddit.com')) return 'reddit'
    if (h.includes('slack.com')) return 'slack'
    if (h.includes('notion.so')) return 'notion'
    if (h.includes('outlook')) return 'outlook'
    return 'web'
  } catch { return 'web' }
}

function getText(el) {
  if (el == null) return ''
  if (typeof el.value === 'string') return el.value
  return el.innerText ?? el.textContent ?? ''
}

function isComposable(el) {
  if (!el) return false
  const tag = el.tagName?.toLowerCase()
  if (tag === 'input' && /text|email/.test(el.type ?? 'text')) return true
  if (tag === 'textarea') return true
  if (el.isContentEditable) return true
  return false
}

function isSendButton(el) {
  if (!el) return false
  const tag  = el.tagName?.toLowerCase()
  const text = (el.textContent ?? '').trim().toLowerCase()
  const aria = (el.getAttribute('aria-label') ?? '').toLowerCase()
  const tid  = el.getAttribute('data-testid') ?? ''
  if (tag === 'button' || el.getAttribute('role') === 'button') {
    if (/^(send|post|reply|tweet|submit|comment|publish)$/.test(text)) return true
    if (/send|post|reply|tweet|submit|comment/i.test(aria)) return true
    if (/tweetButton|sendButton|submitButton/i.test(tid)) return true
  }
  if (tag === 'input' && el.type === 'submit') return true
  return false
}

function send(event, extra = {}) {
  const payload = {
    event,
    url:      location.href,
    platform: getPlatform(location.href),
    ...extra,
  }
  console.log('[Blopus]', event, { platform: payload.platform, url: location.href.slice(0, 60), text: (extra.text_sample ?? '').slice(0, 40) })
  fetch(`http://127.0.0.1:${BLOPUS_PORT}/intent`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  })
    .then(r => r.json())
    .then(d => console.log('[Blopus] server →', d.action))
    .catch(() => console.log('[Blopus] server unreachable'))
}

function sendBrowser(event, extra = {}) {
  fetch(`http://127.0.0.1:${BLOPUS_PORT}/browser`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ event, url: location.href, ...extra }),
  }).catch(() => {})
}

// ─── Compose focus ───────────────────────────────────────────────────────────
// Ghost/compose tracking only runs on messaging sites — not YouTube, Google, etc.
let activeCompose = null

document.addEventListener('focusin', (e) => {
  if (!isComposeHost() || !isComposable(e.target)) return
  activeCompose = e.target
  send('compose_focus', { text_sample: getText(e.target).slice(0, 500) })
}, true)

document.addEventListener('focusout', (e) => {
  if (e.target === activeCompose) activeCompose = null
}, true)

// ─── Typing pause ─────────────────────────────────────────────────────────────
let typingTimer = null
let lastText    = ''

document.addEventListener('input', (e) => {
  if (!isComposeHost() || !isComposable(e.target)) return
  // Hide ghost immediately when user starts typing again
  send('send_out', {})
  clearTimeout(typingTimer)
  typingTimer = setTimeout(() => {
    const text = getText(e.target)
    if (text === lastText) return
    lastText = text
    send('typing_pause', { duration: 2, text_sample: text.slice(0, 500) })
  }, 2000)
}, true)

// ─── Scroll pause ─────────────────────────────────────────────────────────────
let scrollTimer = null

window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => {
    send('scroll_pause', { duration: 5 })
  }, 5000)
}, { passive: true })

// ─── Send hover + click ───────────────────────────────────────────────────────
document.addEventListener('mouseover', (e) => {
  if (!isComposeHost()) return
  const btn = isSendButton(e.target) ? e.target : e.target?.closest?.('button,[role=button]')
  if (!btn || !isSendButton(btn)) return
  const text = activeCompose ? getText(activeCompose).slice(0, 500) : ''
  send('send_hover', { text_sample: text })
}, true)

document.addEventListener('mouseout', (e) => {
  if (!isComposeHost()) return
  const btn = isSendButton(e.target) ? e.target : e.target?.closest?.('button,[role=button]')
  if (!btn || !isSendButton(btn)) return
  send('send_out', {})
}, true)

document.addEventListener('click', (e) => {
  const btn = isSendButton(e.target)
    ? e.target
    : e.target?.closest?.('button,[role=button],[type=submit]')
  if (!btn || !isSendButton(btn)) return
  const text = activeCompose ? getText(activeCompose).slice(0, 500) : ''
  fetch(`http://127.0.0.1:${BLOPUS_PORT}/intent`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ event: 'send_click', url: location.href, platform: getPlatform(location.href), text_sample: text }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.action === 'inject' && data.suggestion && activeCompose) {
        if (typeof activeCompose.value === 'string') {
          activeCompose.value = data.suggestion
          activeCompose.dispatchEvent(new Event('input', { bubbles: true }))
        } else if (activeCompose.isContentEditable) {
          activeCompose.innerText = data.suggestion
          activeCompose.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }
    })
    .catch(() => {})
}, true)

// ─── Selected text ────────────────────────────────────────────────────────────
// Classified before sending — noise is dropped, medium stored, strong fires BubbleBrain.

// ─── Selection noise filter (lightweight — no classification, just drop garbage) ──
const UI_LABELS = /^(click here|next|previous|back|login|sign in|sign up|menu|search|home|close|cancel|submit|read more|learn more|see more|show more|get started|try now|buy now|add to cart)$/i

function isSelectionNoise(text) {
  const t = text.trim()
  const words = t.split(/\s+/)
  if (t.length < 10)                             return true  // too short
  if (words.length === 1)                        return true  // single word
  if (/^https?:\/\//.test(t))                   return true  // URL
  if (/\.(com|org|net|io|edu|gov)\b/i.test(t)) return true  // domain
  if (/^\d[\d\s.,%-]*$/.test(t))               return true  // numbers only
  if (UI_LABELS.test(t.toLowerCase()))          return true  // UI label
  return false
}

let selectionTimer = null

document.addEventListener('mouseup', () => {
  clearTimeout(selectionTimer)
  selectionTimer = setTimeout(() => {
    const selected = window.getSelection()?.toString().trim() ?? ''
    if (isSelectionNoise(selected)) return
    console.log('[Blopus] selection stored:', selected.slice(0, 60))
    sendBrowser('selection', { text: selected.slice(0, 1500), url: location.href })
  }, 800)
})

// ─── Page summary ─────────────────────────────────────────────────────────────
// Sent once on load — gives BubbleBrain visible page content instead of just the title.
function extractPageText() {
  const clone = document.body.cloneNode(true)
  clone.querySelectorAll('script,style,nav,header,footer,[role=banner],[role=navigation]').forEach(el => el.remove())
  return (clone.innerText ?? clone.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000)
}

window.addEventListener('load', () => {
  setTimeout(() => {
    const summary = extractPageText()
    if (summary.length < 100) return
    sendBrowser('page_load', { summary })
  }, 1500)
})
