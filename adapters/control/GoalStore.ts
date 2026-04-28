import fs from 'fs'
import path from 'path'

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')

export interface GoalState {
  id: string
  goal: string
  started: string
  deadline?: string
  current_focus: string
  done: string[]
  blockers: string[]
  files: string[]
  status: 'active' | 'completed' | 'cancelled' | 'paused'
  timeout_minutes: number
  notify_chat_id: string
}

function goalsDir(): string {
  const d = path.join(BLOPUS_DIR, 'goals')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function goalDir(id: string): string {
  const d = path.join(goalsDir(), id)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function statePath(id: string): string {
  return path.join(goalsDir(), id, 'state.json')
}

export const GoalStore = {
  load(id: string): GoalState | null {
    try {
      return JSON.parse(fs.readFileSync(statePath(id), 'utf-8'))
    } catch {
      return null
    }
  },

  save(state: GoalState): void {
    goalDir(state.id)
    fs.writeFileSync(statePath(state.id), JSON.stringify(state, null, 2))
  },

  update(id: string, patch: Partial<GoalState>): void {
    const state = GoalStore.load(id)
    if (!state) return
    GoalStore.save({ ...state, ...patch })
  },

  listActive(): GoalState[] {
    try {
      return fs.readdirSync(goalsDir())
        .filter(d => fs.statSync(path.join(goalsDir(), d)).isDirectory())
        .map(d => GoalStore.load(d))
        .filter((g): g is GoalState => g !== null && g.status === 'active')
    } catch {
      return []
    }
  },

  goalDir(id: string): string {
    return goalDir(id)
  },

  create(params: Omit<GoalState, 'id' | 'started' | 'done' | 'blockers' | 'files' | 'status'>): GoalState {
    const id = `goal_${Date.now()}`
    const state: GoalState = {
      id,
      started: new Date().toISOString().split('T')[0],
      done: [],
      blockers: [],
      files: [],
      status: 'active',
      ...params,
    }
    GoalStore.save(state)
    return state
  },
}
