import { spawn } from 'child_process'

export interface WindowContext {
  label:    string   // dedup key — origin+pathname or window title
  fullUrl?: string   // raw URL with query params (browser only)
}

export type TriggerFn = (ctx: WindowContext) => void

function shouldIgnore(s: string): boolean {
  if (!s) return true
  if (/^\d+$/.test(s)) return true
  if (/^blopus$/i.test(s)) return true
  if (/^(powershell|cmd|conhost|task switching|program manager|windows powershell|screen snipping)/i.test(s)) return true
  return false
}

export function startWindowWatcher(onChanged: TriggerFn) {
  let lastLabel   = ''
  let lastFireAt  = 0

  // Reads window title + tries to read browser address bar URL via UIAutomation.
  // Outputs: "URL|https://..." when browser URL detected, else "TITLE|window title"
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class Win32 {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '}',
    '"@',
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    'while ($true) {',
    '  $h = [Win32]::GetForegroundWindow()',
    '  $s = New-Object System.Text.StringBuilder 512',
    '  [Win32]::GetWindowText($h, $s, 512)',
    '  $title = $s.ToString()',
    '  $url = ""',
    '  try {',
    '    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)',
    '    $tbCond = New-Object System.Windows.Automation.PropertyCondition(',
    '      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,',
    '      [System.Windows.Automation.ControlType]::ToolBar)',
    '    $tb = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $tbCond)',
    '    $src = if ($tb) { $tb } else { $el }',
    '    $eCond = New-Object System.Windows.Automation.PropertyCondition(',
    '      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,',
    '      [System.Windows.Automation.ControlType]::Edit)',
    '    $edit = $src.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $eCond)',
    '    if ($edit -ne $null) {',
    '      $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)',
    '      $val = $vp.Current.Value',
    '      if ($val -match "^https?://") { $url = $val }',
    '    }',
    '  } catch {}',
    '  if ($url) { Write-Output "URL|$url" } else { Write-Output "TITLE|$title" }',
    '  Start-Sleep -Milliseconds 500',
    '}',
  ].join('\n')

  const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    shell: false,
    windowsHide: true,
  })

  let buf = ''
  ps.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.trim()
      let label = ''

      let fullUrl: string | undefined
      if (line.startsWith('URL|')) {
        fullUrl = line.slice(4).trim()
        try { label = new URL(fullUrl).origin + new URL(fullUrl).pathname } catch { label = fullUrl }
      } else if (line.startsWith('TITLE|')) {
        label = line.slice(6).trim()
      }

      if (!label || label === lastLabel || shouldIgnore(label)) continue
      // Debounce: URL| and TITLE| both fire for same page within ~500ms — only take first
      const now = Date.now()
      if (now - lastFireAt < 2000) continue
      lastLabel  = label
      lastFireAt = now
      console.log('[WindowWatcher] change →', label)
      const ctx: WindowContext = { label, fullUrl }
      setTimeout(() => onChanged(ctx), 800)
    }
  })

  ps.stderr.on('data', () => {})
  ps.on('exit', code => {
    if (code !== 0 && code !== null) console.error(`[WindowWatcher] exited ${code}`)
  })

  return ps
}
