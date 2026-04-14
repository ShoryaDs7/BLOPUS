/**
 * ClaudeBridge — pipes Telegram messages directly to the claude CLI.
 *
 * Telegram message → spawn `claude -p "message" --dangerously-skip-permissions`
 * → stream output back to Telegram.
 *
 * This IS Claude Code on your phone. Not an agent SDK wrapper.
 * Not WizardBrain. The actual claude CLI process.
 */

import { spawn } from 'child_process'
import path from 'path'

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')

export class ClaudeBridge {
  private notifyFn?: (text: string) => Promise<void>

  setNotify(fn: (text: string) => Promise<void>) {
    this.notifyFn = fn
  }

  async process(_chatId: string, userMessage: string): Promise<string> {
    await this.notifyFn?.('...')
    console.log('[ClaudeBridge] Running claude CLI for:', userMessage.slice(0, 60))

    return new Promise((resolve) => {
      const output: string[] = []
      let errorOutput = ''

      const proc = spawn('claude', [
        '-p', userMessage,
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose',
      ], {
        cwd: BLOPUS_DIR,
        env: { ...process.env },
        shell: true,
      })

      proc.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(l => l.trim())
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            // Collect assistant text responses
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text?.trim()) {
                  output.push(block.text.trim())
                }
              }
            }
            // Final result
            if (event.type === 'result' && event.result?.trim()) {
              output.push(event.result.trim())
            }
          } catch {
            // Non-JSON line — ignore
          }
        }
      })

      proc.stderr.on('data', (data: Buffer) => {
        errorOutput += data.toString()
      })

      proc.on('close', (code) => {
        console.log('[ClaudeBridge] claude CLI exited with code:', code)
        if (output.length > 0) {
          // Return last meaningful response (the final answer)
          resolve(output[output.length - 1])
        } else if (errorOutput) {
          console.error('[ClaudeBridge] stderr:', errorOutput.slice(0, 200))
          resolve(`error: ${errorOutput.slice(0, 200)}`)
        } else {
          resolve('done.')
        }
      })

      proc.on('error', (err) => {
        console.error('[ClaudeBridge] spawn error:', err)
        resolve(`failed to run claude: ${err.message}`)
      })
    })
  }
}
