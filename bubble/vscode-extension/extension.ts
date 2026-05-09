import * as vscode from 'vscode'

const BUBBLE_PORT  = 3847
const BUBBLE_URL   = `http://127.0.0.1:${BUBBLE_PORT}/vscode`

// ── Debounce state ────────────────────────────────────────────────────────────
// VS Code events are noisy. These timers + dedup maps prevent spam.

let   editTimer:    ReturnType<typeof setTimeout> | null = null
const errorsSent  = new Map<string, number>()   // "file:line:msg" → last sent ts
const terminalSent= new Map<string, number>()   // "cmd" → last sent ts

const EDIT_DEBOUNCE_MS    = 2 * 60 * 1000   // 2 min continuous edit on same file
const ERROR_COOLDOWN_MS   = 5 * 60 * 1000   // same error silent for 5 min
const TERMINAL_DEBOUNCE_MS = 30 * 1000      // terminal 30s cooldown

// ── Send ──────────────────────────────────────────────────────────────────────
function send(event: string, payload: Record<string, unknown>): void {
  const body = JSON.stringify({ event, ...payload })
  fetch(BUBBLE_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch(() => {})   // bubble not running = silent
}

// ── File edit tracking ────────────────────────────────────────────────────────
// Fires only after 2 min continuous editing of the same file — not every keystroke.
let editingFile = ''

function onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
  const doc  = e.document
  if (doc.uri.scheme !== 'file') return
  const file = doc.uri.fsPath
  const lang = doc.languageId

  if (editTimer && file !== editingFile) {
    clearTimeout(editTimer)
    editTimer = null
  }
  editingFile = file

  if (editTimer) return   // already counting down for this file

  editTimer = setTimeout(() => {
    editTimer = null
    send('edit_loop', { file, language: lang })
    console.log('[Blopus] edit_loop →', file.split(/[\\/]/).slice(-2).join('/'))
  }, EDIT_DEBOUNCE_MS)
}

// ── Diagnostic errors ─────────────────────────────────────────────────────────
// Fires immediately on new errors, but deduplicates — same error silent for 5 min.
// VS Code errors are trigger only, not truth — BubbleBrain validates via read_file.
function onDiagnosticsChange(uri: vscode.Uri): void {
  const diags = vscode.languages.getDiagnostics(uri)
  const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error)
  if (errors.length === 0) return

  const file = uri.fsPath
  const now  = Date.now()

  for (const err of errors.slice(0, 3)) {   // max 3 errors per file per event
    const line = err.range.start.line + 1
    const msg  = err.message.slice(0, 200)
    const key  = `${file}:${line}:${msg}`

    if ((errorsSent.get(key) ?? 0) + ERROR_COOLDOWN_MS > now) continue   // dedup

    errorsSent.set(key, now)
    send('error', { file, line, message: msg, language: guessLang(file) })
    console.log('[Blopus] error →', file.split(/[\\/]/).slice(-1)[0], `line ${line}`)
  }
}

// ── Terminal failure ──────────────────────────────────────────────────────────
// Fires only on non-zero exit, debounced per command.
// Uses terminal name as proxy — VS Code doesn't expose exit code directly via API,
// so we hook onDidCloseTerminal and check exit status.
function onTerminalClose(terminal: vscode.Terminal): void {
  Promise.resolve(terminal.processId).then(() => {
    handleTerminalExit(terminal)
  })
}

function handleTerminalExit(terminal: vscode.Terminal): void {
  const code = terminal.exitStatus?.code
  if (code === undefined || code === 0) return   // success = ignore

  const name = terminal.name
  const now  = Date.now()
  if ((terminalSent.get(name) ?? 0) + TERMINAL_DEBOUNCE_MS > now) return

  terminalSent.set(name, now)
  send('terminal_fail', { terminal_name: name, exit_code: code })
  console.log('[Blopus] terminal_fail → exit', code, 'in', name)
}

// ── File open ─────────────────────────────────────────────────────────────────
// Awareness signal only — does NOT trigger BubbleBrain directly.
// Just tells bubble which file is active so context is available if friction fires.
function onActiveEditorChange(editor: vscode.TextEditor | undefined): void {
  if (!editor) return
  const doc = editor.document
  if (doc.uri.scheme !== 'file') return
  send('file_open', { file: doc.uri.fsPath, language: doc.languageId })
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function guessLang(file: string): string {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', rb: 'ruby', php: 'php', swift: 'swift',
  }
  return map[ext] ?? ext
}

// ── Activation ────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext): void {
  console.log('[Blopus] bubble extension active')

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(onDocumentChange),
    vscode.languages.onDidChangeDiagnostics(e => {
      for (const uri of e.uris) onDiagnosticsChange(uri)
    }),
    vscode.window.onDidCloseTerminal(onTerminalClose),
    vscode.window.onDidChangeActiveTextEditor(onActiveEditorChange),
  )

  // Send current file immediately on activation
  onActiveEditorChange(vscode.window.activeTextEditor)
}

export function deactivate(): void {
  if (editTimer) clearTimeout(editTimer)
}
