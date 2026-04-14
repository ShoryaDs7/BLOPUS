/**
 * NotebookLMAdapter — Blopus bridge to Google NotebookLM.
 *
 * Wraps the notebooklm-py Python API via child_process.
 * Generates podcasts, slides, quizzes, flashcards, infographics,
 * mind maps and reports from any sources (URLs, text, YouTube).
 *
 * Usage:
 *   const nlm = new NotebookLMAdapter()
 *   const file = await nlm.generate({
 *     title: 'AI Agents This Week',
 *     sources: ['https://...', 'yt: https://youtube.com/...'],
 *     type: 'audio',
 *     prompt: 'deep dive on autonomous agents',
 *   })
 *   // file = 'output/notebooklm/AI_Agents_This_Week.mp3'
 */

import { execSync, spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'

export type ContentType = 'audio' | 'slides' | 'quiz' | 'flashcards' | 'infographic' | 'mindmap' | 'report'

export interface GenerateOptions {
  title: string
  sources: string[]          // URLs, "yt: <url>", or "text: <content>"
  type: ContentType
  prompt?: string            // optional instruction for the LLM
  outDir?: string
}

export interface GenerateResult {
  ok: boolean
  file?: string
  notebookId?: string
  error?: string
}

const SCRIPT = path.resolve('./scripts/notebooklm_generate.py')
const DEFAULT_OUT = path.resolve('./output/notebooklm')

export class NotebookLMAdapter {
  get enabled(): boolean {
    // Check if notebooklm-py is installed and logged in
    try {
      const r = spawnSync('python', ['-m', 'notebooklm', 'list'], { encoding: 'utf-8', timeout: 10000 })
      return r.status === 0
    } catch {
      return false
    }
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    if (!fs.existsSync(SCRIPT)) {
      return { ok: false, error: 'notebooklm_generate.py not found' }
    }

    const payload = JSON.stringify({
      title:   opts.title,
      sources: opts.sources,
      type:    opts.type,
      prompt:  opts.prompt ?? '',
      outDir:  opts.outDir ?? DEFAULT_OUT,
    })

    try {
      console.log(`[NotebookLM] Generating ${opts.type} — "${opts.title}"`)
      const result = spawnSync(
        'python',
        ['scripts/notebooklm_generate.py'],
        {
          input: payload,
          encoding: 'utf-8',
          timeout: 300_000,  // 5 min — generation can take a while
          stdio: ['pipe', 'pipe', 'inherit'],  // stderr → console, stdout → capture
        }
      )

      if (result.status !== 0) {
        return { ok: false, error: result.stderr?.slice(0, 300) ?? 'Python script failed' }
      }

      const out: GenerateResult = JSON.parse(result.stdout.trim())
      if (out.ok && out.file) {
        console.log(`[NotebookLM] ✓ Saved to ${out.file}`)
      }
      return out
    } catch (err: any) {
      return { ok: false, error: String(err) }
    }
  }

  /**
   * Quick helper — generate a podcast from a list of URLs or text snippets.
   * Returns the MP3 file path on success, empty string on failure.
   */
  async podcast(title: string, sources: string[], prompt?: string): Promise<string> {
    const r = await this.generate({ title, sources, type: 'audio', prompt })
    return r.ok ? (r.file ?? '') : ''
  }

  /**
   * Generate content from Blopus memory topics.
   * Converts recent memory topics into text sources for NotebookLM.
   */
  async fromTopics(topics: string[], type: ContentType, title?: string): Promise<GenerateResult> {
    const textSource = `text: Topics to cover: ${topics.join(', ')}. Generate content about these subjects.`
    return this.generate({
      title: title ?? `Blopus — ${topics.slice(0, 3).join(', ')}`,
      sources: [textSource],
      type,
    })
  }
}
