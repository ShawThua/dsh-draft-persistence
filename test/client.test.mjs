import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

await import(pathToFileURL(join(import.meta.dirname, '..', 'client.js')).href)
assert.ok(captured, 'client.js must register a module loader entry')
assert.equal(captured.id, 'dsh-draft-persistence')

const fakeReact = {
  createElement() {},
  useEffect() {},
}
const moduleExports = captured.factory((request) => {
  if (request === 'react') return fakeReact
  throw new Error(`unexpected require(${JSON.stringify(request)})`)
})
const { createKeeper, normalizeDraft, hasContent } = moduleExports.__test

const tick = () => new Promise((resolve) => setImmediate(resolve))

function fakeShell(text = '') {
  let draft = text
  let rev = text === '' ? 0 : 1
  const listeners = new Set()
  const shell = {
    get draftSnapshot() {
      return { text: draft, references: [] }
    },
    state: {
      getSnapshot: () => ({ draft, draftRev: rev, attachmentIds: [], phase: 'plain' }),
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    setDraft(value) {
      const next = typeof value === 'string' ? value : value.text
      if (next === draft) return
      draft = next
      rev += 1
      shell.emits += 1
      for (const listener of [...listeners]) listener()
    },
    type(value) {
      if (value === draft) return
      draft = value
      rev += 1
      shell.emits += 1
      for (const listener of [...listeners]) listener()
    },
    get text() {
      return draft
    },
    emits: 0,
  }
  return shell
}

function fakeHost() {
  const records = new Map()
  const calls = []
  let clock = 10_000
  return {
    calls,
    records,
    get clock() {
      return clock
    },
    advanceClock(ms) {
      clock += ms
    },
    async request(path, options = {}) {
      calls.push({ path, options })
      const url = new URL(path, 'http://draft.local')
      if (url.pathname.endsWith('/get')) {
        const sessionId = url.searchParams.get('sessionId')
        return { ok: true, record: records.get(sessionId) ?? null }
      }
      if (url.pathname.endsWith('/put')) {
        const body = options.body
        const current = records.get(body.sessionId)
        if (current !== undefined && body.force !== true && body.baseRev !== current.rev
          && JSON.stringify(current.draft) !== JSON.stringify(body.draft)) {
          return { ok: true, conflict: true, record: current }
        }
        const record = {
          sessionId: body.sessionId,
          draft: body.draft,
          rev: (current?.rev ?? 0) + 1,
          updatedAt: clock,
        }
        records.set(body.sessionId, record)
        return { ok: true, rev: record.rev, updatedAt: record.updatedAt }
      }
      if (url.pathname.endsWith('/delete')) {
        records.delete(options.body.sessionId)
        return { ok: true, deleted: true }
      }
      throw new Error(`unexpected path ${path}`)
    },
  }
}

function fakeClock() {
  let value = 10_000
  const timers = []
  return {
    now: () => value,
    setTimer(fn, ms) {
      const timer = { at: value + ms, fn }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
    async advance(ms) {
      value += ms
      const due = timers.filter((timer) => timer.at <= value)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
        timer.fn()
      }
      await tick()
      await tick()
    },
  }
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

function setup(options = {}) {
  const host = fakeHost()
  const clock = fakeClock()
  const shell = fakeShell(options.initialText ?? '')
  const storage = memoryStorage(options.storage)
  const keeper = createKeeper({
    sessionId: 'session-a',
    getShell: () => shell,
    request: host.request,
    storage,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    debounceMs: 700,
    maxWaitMs: 3000,
    writer: 'test',
    log: () => {},
  })
  return { host, clock, shell, storage, keeper }
}

test('normalizeDraft keeps only safe, restorable fields', () => {
  assert.deepEqual(normalizeDraft('hello'), { text: 'hello', references: [] })
  const draft = normalizeDraft({
    text: 'x',
    references: [
      { offset: 0, clipboardText: '@a', ref: 'a', source: 'file' },
      { offset: 'bad' },
      { clipboardText: 'no offset' },
    ],
    command: { token: '/plan' },
    quotes: [{ text: 'q' }],
    extra: () => {},
  })
  assert.equal(draft.references.length, 1)
  assert.equal(draft.references[0].ref, 'a')
  assert.deepEqual(draft.command, { token: '/plan' })
  assert.equal(draft.quotes.length, 1)
  assert.equal('extra' in draft, false)
  assert.equal(hasContent({ text: '   ' }), false)
  assert.equal(hasContent({ text: 'a' }), true)
})

test('typing is debounced and lands in the Host store', async () => {
  const { host, clock, shell, keeper } = setup()
  keeper.start()
  await tick()
  shell.type('hello world')
  await clock.advance(300)
  assert.equal(host.calls.filter((call) => call.path.startsWith('/put')).length, 0)
  await clock.advance(500)
  assert.equal(host.records.get('session-a').draft.text, 'hello world')
})

test('a Host draft restores into an empty composer', async () => {
  const { host, shell, keeper } = setup()
  host.records.set('session-a', { sessionId: 'session-a', draft: { text: 'from host', references: [] }, rev: 3, updatedAt: 9_000 })
  keeper.start()
  await tick()
  assert.equal(shell.text, 'from host')
  assert.equal(keeper.getState().rev, 3)
})

test('local text wins when the composer is not empty on mount', async () => {
  const { host, shell, keeper } = setup({ initialText: 'local draft' })
  host.records.set('session-a', { sessionId: 'session-a', draft: { text: 'older host', references: [] }, rev: 1, updatedAt: 1_000 })
  keeper.start()
  await tick()
  assert.equal(shell.text, 'local draft')
  assert.equal(host.records.get('session-a').draft.text, 'local draft')
})

test('a Host draft newer than this browser wins when nothing was typed yet', async () => {
  const { host, shell, keeper, storage } = setup({ initialText: 'stale local' })
  storage.setItem('dsh-draft-persistence.saved-at.session-a', '5000')
  host.records.set('session-a', { sessionId: 'session-a', draft: { text: 'newer host', references: [] }, rev: 4, updatedAt: 20_000 })
  keeper.start()
  await tick()
  assert.equal(shell.text, 'newer host')
})

test('clearing the composer deletes the Host draft immediately', async () => {
  const { host, clock, shell, keeper } = setup()
  keeper.start()
  await tick()
  shell.type('temporary')
  await clock.advance(800)
  assert.equal(host.records.get('session-a').draft.text, 'temporary')
  shell.type('')
  await tick()
  assert.equal(host.records.has('session-a'), false)
  const deletes = host.calls.filter((call) => call.path === '/delete')
  assert.equal(deletes.length, 1)
})

test('a failed save keeps the draft for the next flush instead of dropping it', async () => {
  const { host, clock, shell, keeper } = setup()
  const originalRequest = host.request
  let failures = 1
  const flaky = {
    ...host,
    async request(path, options) {
      if (path === '/put' && failures > 0) {
        failures -= 1
        throw new Error('network down')
      }
      return originalRequest(path, options)
    },
  }
  const keeper2 = createKeeper({
    sessionId: 'session-a',
    getShell: () => shell,
    request: flaky.request,
    storage: memoryStorage(),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    debounceMs: 700,
    writer: 'test',
    log: () => {},
  })
  keeper2.start()
  await tick()
  shell.type('kept')
  await clock.advance(800)
  assert.ok(keeper2.getState().pending !== null)
  shell.type('kept again')
  await clock.advance(800)
  assert.equal(host.records.get('session-a').draft.text, 'kept again')
  keeper.dispose()
  keeper2.dispose()
})

test('pagehide flushes the pending draft with keepalive', async () => {
  const { host, shell, keeper } = setup()
  keeper.start()
  await tick()
  shell.type('before unload')
  keeper.pagehide()
  await tick()
  const put = host.calls.filter((call) => call.path === '/put').at(-1)
  assert.equal(put.options.keepalive, true)
  assert.equal(host.records.get('session-a').draft.text, 'before unload')
})

test('dispose flushes the pending draft', async () => {
  const { host, shell, keeper } = setup()
  keeper.start()
  await tick()
  shell.type('on switch')
  keeper.dispose()
  await tick()
  assert.equal(host.records.get('session-a').draft.text, 'on switch')
})

test('a revision conflict from another device lets the actively edited draft win', async () => {
  const { host, clock, shell, keeper } = setup()
  keeper.start()
  await tick()
  shell.type('mine')
  await clock.advance(800)
  // Another client wrote a newer revision.
  host.records.set('session-a', { sessionId: 'session-a', draft: { text: 'theirs', references: [] }, rev: 9, updatedAt: 30_000 })
  shell.type('mine, edited after the conflict')
  await clock.advance(800)
  assert.equal(host.records.get('session-a').draft.text, 'mine, edited after the conflict')
  const forced = host.calls.filter((call) => call.path === '/put' && call.options.body.force === true)
  assert.equal(forced.length, 1)
})

