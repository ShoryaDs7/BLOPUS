#!/usr/bin/env npx tsx
import { execSync, execFileSync } from 'child_process'
import readline from 'readline'
import path from 'path'
import fs from 'fs'
import os from 'os'

async function main() {
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string) => new Promise<string>(r => rl.question(q, a => r(a.trim())))

const ROOT          = process.cwd()
const extensionPath = path.resolve(ROOT, 'bubble', 'extension')
const vsExtDir      = path.resolve(ROOT, 'bubble', 'vscode-extension')

// ── Step 0: API keys ─────────────────────────────────────────────────────────
const envPath = path.join(ROOT, '.env')
const envExists = fs.existsSync(envPath)
const envContent = envExists ? fs.readFileSync(envPath, 'utf-8') : ''
const hasAnthropicKey = /^ANTHROPIC_API_KEY=.+/m.test(envContent)
const hasTavilyKey    = /^TAVILY_API_KEY=.+/m.test(envContent)

if (!hasAnthropicKey || !hasTavilyKey) {
  console.log('\n' + '═'.repeat(58))
  console.log('  Blopus Bubble — API Keys')
  console.log('═'.repeat(58))

  let newEnv = envContent

  if (!hasAnthropicKey) {
    console.log('\n  Anthropic API key required — powers everything.')
    console.log('  Get it at: https://console.anthropic.com → API Keys\n')
    const key = await ask('  ANTHROPIC_API_KEY (sk-ant-...): ')
    if (key) newEnv += `\nANTHROPIC_API_KEY=${key}`
    else { console.log('\n  Skipped — bubble will not work without this key.') }
  } else {
    console.log('\n  ✓ ANTHROPIC_API_KEY already set')
  }

  if (!hasTavilyKey) {
    console.log('\n  Tavily key enables web search (free tier: 1000/month).')
    console.log('  Get it at: https://tavily.com → API Keys')
    console.log('  Press Enter to skip (search features disabled).\n')
    const key = await ask('  TAVILY_API_KEY: ')
    if (key) newEnv += `\nTAVILY_API_KEY=${key}`
  } else {
    console.log('  ✓ TAVILY_API_KEY already set')
  }

  fs.writeFileSync(envPath, newEnv.trim() + '\n', 'utf-8')
  console.log('\n  ✓ Saved to .env')
}

// ── Ensure minimal config exists ─────────────────────────────────────────────
const configDir  = path.join(ROOT, 'config')
const configPath = path.join(configDir, 'blopus.config.json')
if (!fs.existsSync(configPath)) {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    owner:  { handle: 'user', displayName: 'User' },
    osbot:  { handle: 'blopus' },
    blopus: { handle: 'blopus' },
  }, null, 2), 'utf-8')
  console.log('  ✓ Created config/blopus.config.json')
}

console.log('\n' + '═'.repeat(58))
console.log('  Blopus Bubble — Chrome Extension Setup')
console.log('═'.repeat(58))
console.log(`
  What it is:
    Most AI writing tools wait for you to ask for help.
    Blopus doesn't. This extension gives it eyes inside Chrome.

    It watches compose boxes across every website — Gmail, X,
    LinkedIn, Reddit, Slack, Notion, anywhere you type — and
    runs a real-time intent scoring system in the background.
    Scroll past something? Ignored. Click a field? Low score.
    Type a real draft and pause? Score crosses the threshold.

    The moment you pause, Blopus has already pre-computed a
    sharper version of your message — in your voice, for your
    platform — before you've even thought about hitting Send.

    When you hover Send, the improved version appears as a ghost
    suggestion in the bubble overlay. Silent. Zero interruption.
    You decide in half a second: use it or ignore it.

    90% of events are silently discarded. It only speaks when
    there is something genuinely worth saying. That precision
    is the whole point — this is a judgment engine, not a
    suggestion engine. The difference is everything.

  What it does NOT do:
    → Does not read passwords, login forms, or private browsing
    → Does not send your text to any third party — only to
      Anthropic's API (the same API powering all of Blopus)
      via your own API key, on your own account
    → Goes completely dormant when the bubble is not running
`)
console.log('─'.repeat(58))
console.log('  Install (30 seconds, never again):')
console.log('─'.repeat(58))
console.log(`
    1. Chrome will open to chrome://extensions
    2. Toggle ON "Developer mode"  (top-right corner)
    3. Click "Load unpacked"
    4. Select this exact folder:

         ${extensionPath}

    5. You will see "Blopus Intent" appear in your extensions.
       That's it — never do this again.
`)

console.log('  → In Chrome, paste this in the address bar and hit Enter:\n')
console.log('       chrome://extensions\n')

await ask('  Press Enter once installed (or Enter to skip): ')

// ── VS Code / Cursor extension ────────────────────────────────────────────────
console.log('\n' + '═'.repeat(58))
console.log('  Blopus Bubble — VS Code / Cursor Extension Setup')
console.log('═'.repeat(58))
console.log(`
  What it does:
    Gives Blopus eyes inside your code editor.
    When you're stuck on an error or editing the same file
    repeatedly, Blopus detects it and surfaces a diagnosis —
    not a generic web answer, but one based on your actual code.

    Works in VS Code and Cursor identically.
`)

// Compile extension TypeScript → JavaScript
console.log('  Compiling extension...')
try {
  execSync('npm install --silent', { cwd: vsExtDir, stdio: 'pipe' })
  execSync('npx tsc -p tsconfig.json', { cwd: vsExtDir, stdio: 'pipe' })
  console.log('  ✓ Compiled\n')
} catch (e: any) {
  console.log('  ✗ Compile failed:', e.message?.slice(0, 100))
  console.log('  Skipping VS Code extension.\n')
  console.log('\n  Done. Run the bubble with:  npm run bubble\n')
  rl.close()
  return
}

// Detect extensions directories for VS Code and Cursor
const home = os.homedir()
const targets: { name: string; dir: string }[] = [
  { name: 'VS Code', dir: path.join(home, '.vscode',  'extensions', 'blopus-bubble-0.1.0') },
  { name: 'Cursor',  dir: path.join(home, '.cursor',  'extensions', 'blopus-bubble-0.1.0') },
]

const filesToCopy = ['extension.js', 'package.json']
let installed = 0

for (const target of targets) {
  const parentExists = fs.existsSync(path.dirname(target.dir))
  if (!parentExists) continue   // editor not installed — skip silently

  try {
    fs.mkdirSync(target.dir, { recursive: true })
    for (const f of filesToCopy) {
      const src = path.join(vsExtDir, f)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target.dir, f))
    }
    console.log(`  ✓ Installed into ${target.name}`)
    installed++
  } catch (e: any) {
    console.log(`  ✗ ${target.name} install failed:`, e.message?.slice(0, 80))
  }
}

if (installed === 0) {
  console.log('\n  VS Code and Cursor not detected.')
  console.log('  To install manually, copy this folder into your editor\'s extensions directory:')
  console.log(`\n    ${vsExtDir}\n`)
} else {
  console.log('\n  Restart VS Code / Cursor to activate the extension.')
}

console.log('\n  Done. Run the bubble with:  npm run bubble\n')
rl.close()
}

main().catch(e => { console.error(e); process.exit(1) })
