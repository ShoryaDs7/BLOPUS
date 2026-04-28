import cron from 'node-cron'
import { ScheduleStore, ScheduledTask } from '../adapters/control/ScheduleStore'
import type { XTools } from '../adapters/control/XTools'

export class TaskRunner {
  private jobs = new Map<string, cron.ScheduledTask>()

  constructor(private xtools: XTools) {}

  start(): void {
    const tasks = ScheduleStore.load()
    for (const task of tasks) this.schedule(task)
    console.log(`[TaskRunner] Started — ${tasks.length} task(s) scheduled`)
  }

  schedule(task: ScheduledTask): void {
    if (!cron.validate(task.cron)) {
      console.warn(`[TaskRunner] Invalid cron "${task.cron}" for task "${task.description}" — skipped`)
      return
    }
    const job = cron.schedule(task.cron, async () => {
      console.log(`[TaskRunner] Firing: ${task.description}`)
      try {
        const result = await this.xtools.execute(task.tool, task.tool_input)
        await this.notify(`✅ Scheduled: ${task.description}\n\n${result.slice(0, 300)}`)
      } catch (err: any) {
        await this.notify(`❌ Scheduled task failed: ${task.description}\n${String(err).slice(0, 100)}`)
      }
      if (task.one_time) {
        job.stop()
        this.jobs.delete(task.id)
        ScheduleStore.remove(task.id)
        console.log(`[TaskRunner] One-time task ${task.id} fired and removed`)
      }
    })
    this.jobs.set(task.id, job)
  }

  add(task: ScheduledTask): void {
    ScheduleStore.add(task)
    this.schedule(task)
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (job) { job.stop(); this.jobs.delete(id) }
    return ScheduleStore.remove(id)
  }

  list(): ScheduledTask[] {
    return ScheduleStore.load()
  }

  private async notify(text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
    if (!token || !chatId) return
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => {})
  }
}
