/**
 * UserContext — persistent memory of what the user tells OsBot via Telegram.
 *
 * Facts are saved as a JSON array. Each fact has:
 * - text: the actual fact ("user has exams starting next week")
 * - category: personal | schedule | work | instruction | goal
 * - createdAt: ISO timestamp
 * - expiresAt: optional ISO timestamp — expired facts are pruned automatically
 *
 * Stored at memory-store/user_context.json.
 * Loaded fresh on every WizardBrain message — never stale.
 */

import fs from 'fs'
import path from 'path'

export type FactCategory = 'personal' | 'schedule' | 'work' | 'instruction' | 'goal'

export interface UserFact {
  text: string
  category: FactCategory
  createdAt: string
  expiresAt?: string
}

export class UserContext {
  private filePath: string
  private facts: UserFact[] = []

  constructor(configPath: string) {
    this.filePath = path.join(path.dirname(path.resolve(configPath)), '../memory-store/user_context.json')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as UserFact[]
        // Prune expired facts on load
        const now = Date.now()
        this.facts = raw.filter(f => !f.expiresAt || new Date(f.expiresAt).getTime() > now)
      }
    } catch {
      this.facts = []
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.facts, null, 2))
    } catch (err) {
      console.warn('[UserContext] Failed to save:', err)
    }
  }

  addFact(text: string, category: FactCategory, expiresDays?: number): void {
    // Reload fresh before writing to avoid overwriting concurrent changes
    this.load()

    // Avoid near-duplicate facts — if same text exists, update it
    const existingIdx = this.facts.findIndex(f =>
      f.text.toLowerCase() === text.toLowerCase()
    )

    const fact: UserFact = {
      text,
      category,
      createdAt: new Date().toISOString(),
      expiresAt: expiresDays
        ? new Date(Date.now() + expiresDays * 86_400_000).toISOString()
        : undefined,
    }

    if (existingIdx >= 0) {
      this.facts[existingIdx] = fact
    } else {
      this.facts.push(fact)
    }

    this.save()
    console.log(`[UserContext] Saved fact (${category}): "${text}"`)
  }

  removeFact(text: string): void {
    this.load()
    this.facts = this.facts.filter(f => !f.text.toLowerCase().includes(text.toLowerCase()))
    this.save()
  }

  getAll(): UserFact[] {
    this.load()
    return this.facts
  }

  /** Returns a formatted block for injecting into prompts */
  toPromptBlock(): string {
    this.load()
    if (this.facts.length === 0) return ''
    const lines = this.facts.map(f => {
      const expiry = f.expiresAt ? ` (until ${new Date(f.expiresAt).toLocaleDateString()})` : ''
      return `- [${f.category}] ${f.text}${expiry}`
    })
    return `What you know about the user:\n${lines.join('\n')}`
  }

  /** Returns personal/schedule facts — used by autonomous posting if user posts personal content */
  getPersonalFacts(): UserFact[] {
    this.load()
    return this.facts.filter(f => f.category === 'personal' || f.category === 'schedule')
  }
}
