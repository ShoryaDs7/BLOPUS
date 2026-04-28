import fs from 'fs'
import path from 'path'

export interface ScheduledTask {
  id: string
  description: string
  tool: string
  tool_input: Record<string, any>
  cron: string        // e.g. "0 9 * * *" = every day 9am
  one_time: boolean   // delete after first fire
  created_at: string
}

function getStorePath(): string {
  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  return path.join(path.dirname(path.resolve(configPath)), 'scheduled_tasks.json')
}

export const ScheduleStore = {
  load(): ScheduledTask[] {
    try {
      const p = getStorePath()
      if (!fs.existsSync(p)) return []
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as ScheduledTask[]
    } catch { return [] }
  },

  save(tasks: ScheduledTask[]): void {
    try {
      fs.writeFileSync(getStorePath(), JSON.stringify(tasks, null, 2))
    } catch {}
  },

  add(task: ScheduledTask): void {
    const tasks = this.load()
    tasks.push(task)
    this.save(tasks)
  },

  remove(id: string): boolean {
    const tasks = this.load()
    const filtered = tasks.filter(t => t.id !== id)
    if (filtered.length === tasks.length) return false
    this.save(filtered)
    return true
  },
}
