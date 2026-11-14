#!/usr/bin/env node
// End-to-end verification for dsh-draft-persistence against a live DSH Web Host.
//
// It opens a fresh headless Chrome profile (empty localStorage), types into a real
// Session composer, verifies the Host copy, clears localStorage, reloads the page,
// verifies the draft comes back from the Host, then clears the composer and checks
// the record is deleted.
//
// Environment:
//   DSH_WEB_URL     base URL of the DSH Web Host (default http://127.0.0.1:7979)
//   DSH_TOKEN       access token (optional; read from DSH_TOKEN_FILE otherwise)
//   DSH_TOKEN_FILE  file containing the URL with a token query (default:
//                   %LOCALAPPDATA%\DSH\portal\url.txt on Windows)
//   DSH_HOME        DSH home directory (default ~/.dsh)
//   DRAFTS_FILE     override path of drafts.json
//   CHROME_PATH     Chrome/Edge executable (default: platform search)
//   SESSION_TITLE   Session to type into (required)
//   OTHER_TITLE     another Session used for the switch test (optional)
//   HEADLESS        "0" to watch the browser (default "1")
//
// Exits 0 when every check passes.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
const DRAFTS_FILE = process.env.DRAFTS_FILE?.trim() || path.join(HOME, 'storages', 'dsh-draft', 'drafts.json')
const baseUrl = (process.env.DSH_WEB_URL?.trim() || 'http://127.0.0.1:7979').replace(/\/+$/, '')
const TARGET_TITLE = process.env.SESSION_TITLE?.trim()
const OTHER_TITLE = process.env.OTHER_TITLE?.trim() || ''
const HEADLESS = process.env.HEADLESS !== '0'

if (!TARGET_TITLE) {
  console.error('SESSION_TITLE is required (the Session the script may type into).')
  process.exit(2)
}

function findChrome() {
  const explicit = process.env.CHROME_PATH?.trim()
  if (explicit) return explicit
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch { /* keep searching */ }
  }
  throw new Error('No Chrome/Edge found; set CHROME_PATH')
}

function resolveUrl() {
  const token = process.env.DSH_TOKEN?.trim()
  if (token) return `${baseUrl}/?token=${encodeURIComponent(token)}`
  const tokenFile = process.env.DSH_TOKEN_FILE?.trim()
    || (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? '', 'DSH', 'portal', 'url.txt')
      : '')
  if (tokenFile && fs.existsSync(tokenFile)) {
    const match = /token=([A-Za-z0-9_-]+)/.exec(fs.readFileSync(tokenFile, 'utf8'))
    if (match) return `${baseUrl}/?token=${match[1]}`
  }
  return `${baseUrl}/`
}

const url = resolveUrl()
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-draft-e2e-'))
const port = 9500 + Math.floor(Math.random() * 300)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8')).drafts ?? {}
  } catch {
    return {}
  }
}

const chromeArgs = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1400,900',
  'about:blank',
]
if (HEADLESS) chromeArgs.unshift('--headless=new')

const chrome = spawn(findChrome(), chromeArgs, { stdio: 'ignore' })

let ws
let messageId = 0
let sessionId = null
const pending = new Map()

function send(method, params = {}, useSession = true) {
  const message = { id: ++messageId, method, params }
  if (useSession && sessionId) message.sessionId = sessionId
  return new Promise((resolve, reject) => {
    pending.set(message.id, { resolve, reject })
    ws.send(JSON.stringify(message))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
  }
  return result.result.value
}

async function waitFor(expression, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true
    } catch { /* page is between navigations */ }
    await sleep(400)
  }
  return false
}

const composerText = () => evaluate(`(() => {
  const el = document.querySelector('[contenteditable="true"]')
  return el ? el.innerText : null
})()`)

const focusComposer = () => evaluate(`(() => {
  const el = document.querySelector('[contenteditable="true"]')
  if (!el) return false
  el.focus()
  return document.activeElement === el
})()`)

const currentSession = () => evaluate(`(() => {
  const el = document.querySelector('[data-conversation-session]')
  return el ? el.getAttribute('data-conversation-session') : null
})()`)

async function clickSession(title) {
  const outcome = await evaluate(`(() => {
    const wanted = ${JSON.stringify(title)}
    const nodes = [...document.querySelectorAll('a,button,[role="button"],[role="treeitem"],li,span,div')]
    const matches = nodes.filter((node) => (node.textContent || '').trim() === wanted)
    if (matches.length === 0) return 'none'
    const target = matches[matches.length - 1]
    target.click()
    return 'clicked ' + target.tagName + ' of ' + matches.length
  })()`)
  await sleep(2500)
  return outcome
}

async function dispatchKey(key, code, virtualKeyCode, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, key, code, windowsVirtualKeyCode: virtualKeyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: virtualKeyCode })
}

try {
  let version
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      break
    } catch {
      await sleep(250)
    }
  }
  if (!version) throw new Error('Chrome did not expose the CDP endpoint')

  ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
  }

  const target = await send('Target.createTarget', { url: 'about:blank' }, false)
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false)
  sessionId = attached.sessionId
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url })
  if (!(await waitFor(`!!document.querySelector('[contenteditable="true"]')`))) throw new Error('the Web UI never booted')

  const click = await clickSession(TARGET_TITLE)
  const targetSession = await currentSession()
  check('open target session', click.startsWith('clicked') && typeof targetSession === 'string' && targetSession !== 'null', { click, targetSession })
  if (!targetSession || targetSession === 'null') throw new Error('no Session id; aborting before typing')

  const stamp = new Date().toISOString()
  const draftText = `E2E draft check ${stamp}: this text is not sent and must survive a reload.`
  await focusComposer()
  await send('Input.insertText', { text: draftText })
  await sleep(1500)
  const typed = await composerText()
  check('draft text is in the composer', typed && typed.includes(stamp), typed)

  await sleep(500)
  const stored = readStore()[targetSession]
  check('Host draft stored', Boolean(stored?.draft) && String(stored.draft.text).includes(stamp),
    stored && { rev: stored.rev, chars: stored.draft.text.length, updatedAt: stored.updatedAt })

  if (OTHER_TITLE !== '') {
    await clickSession(OTHER_TITLE)
    const otherSession = await currentSession()
    await clickSession(TARGET_TITLE)
    const backSession = await currentSession()
    const afterSwitch = await composerText()
    check('draft survives a Session switch',
      backSession === targetSession && otherSession !== targetSession && Boolean(afterSwitch?.includes(stamp)),
      { otherSession, backSession })
  }

  await evaluate('localStorage.clear()')
  await send('Page.reload', { ignoreCache: true })
  if (!(await waitFor(`!!document.querySelector('[contenteditable="true"]')`))) throw new Error('the Web UI never booted after reload')
  await sleep(1000)
  const reopen = await clickSession(TARGET_TITLE)
  const reopenedSession = await currentSession()
  const restored = await composerText()
  check('draft restored from the Host after reload (localStorage cleared)',
    reopenedSession === targetSession && Boolean(restored?.includes(stamp)),
    { reopen, session: reopenedSession, restored })

  await focusComposer()
  await dispatchKey('a', 'KeyA', 65, 2)
  await dispatchKey('Backspace', 'Backspace', 8)
  await sleep(1200)
  const cleared = await composerText()
  const emptied = cleared === null || String(cleared).trim() === ''
  const recordAfterClear = readStore()[targetSession]
  check('clearing the composer deletes the Host draft', emptied && !recordAfterClear,
    { cleared, recordAfterClear: recordAfterClear ?? null })

  if (readStore()[targetSession]) {
    await fetch(`${url.replace(/\/+$/, '')}/dsh-draft/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: targetSession }),
    }).catch(() => {})
    check('cleanup removed the leftover record', !readStore()[targetSession])
  }
  if (!emptied) check('WARNING: the test browser still holds draft text', false, cleared)
} catch (error) {
  check('e2e run completed', false, error.message)
} finally {
  try { ws?.close() } catch { /* ignore */ }
  try { chrome.kill() } catch { /* ignore */ }
  await sleep(300)
  try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}
