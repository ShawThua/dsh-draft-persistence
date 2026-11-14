import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { DraftStore, DraftStoreError, apply, createHandler, normalizeDraft, resolveHome } from '../index.js'

async function tempFile() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-draft-test-'))
  return { directory, file: join(directory, 'drafts.json') }
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

function store(file, overrides = {}) {
  return new DraftStore({ filePath: file, logger: silentLogger, ...overrides })
}

test('put, get and delete round-trip through an atomic file', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const drafts = store(file)

  const created = await drafts.put({ sessionId: 'session-a', draft: 'hello', baseRev: 0, writer: 'w1' })
  assert.equal(created.ok, true)
  assert.equal(created.rev, 1)

  const loaded = await drafts.get('session-a')
  assert.equal(loaded.draft.text, 'hello')
  assert.equal(loaded.rev, 1)

  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.version, 1)
  assert.equal(document.drafts['session-a'].draft.text, 'hello')

  const removed = await drafts.delete({ sessionId: 'session-a' })
  assert.deepEqual(removed, { ok: true, deleted: true })
  assert.equal(await drafts.get('session-a'), null)
  const afterDelete = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(afterDelete.drafts, {})
})

test('a newer draft survives a fresh store instance (Host restart)', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  await store(file).put({ sessionId: 'session-a', draft: { text: 'first draft', references: [] }, baseRev: 0 })
  const reopened = store(file)
  const record = await reopened.get('session-a')
  assert.equal(record.draft.text, 'first draft')
  assert.equal(record.rev, 1)
})

test('optimistic revision refuses to overwrite a newer record without force', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const drafts = store(file)
  await drafts.put({ sessionId: 'session-a', draft: 'one', baseRev: 0 })
  await drafts.put({ sessionId: 'session-a', draft: 'two', baseRev: 1 })

  const stale = await drafts.put({ sessionId: 'session-a', draft: 'stale', baseRev: 1 })
  assert.equal(stale.ok, true)
  assert.equal(stale.conflict, true)
  assert.equal(stale.record.draft.text, 'two')

  const forced = await drafts.put({ sessionId: 'session-a', draft: 'stale', baseRev: 1, force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.rev, 3)
  assert.equal((await drafts.get('session-a')).draft.text, 'stale')
})

test('an identical put is a no-op that keeps the revision', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const drafts = store(file)
  await drafts.put({ sessionId: 'session-a', draft: { text: 'x', references: [] }, baseRev: 0 })
  const again = await drafts.put({ sessionId: 'session-a', draft: { text: 'x', references: [] }, baseRev: 0 })
  assert.equal(again.unchanged, true)
  assert.equal(again.rev, 1)
})

test('semantic drafts keep reference chips and command claims', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const draft = {
    text: '@README.md 看这个',
    references: [{ source: 'file', ref: 'README.md', offset: 0, length: 10, label: 'README.md', clipboardText: '@README.md' }],
    command: { token: '/plan' },
    quotes: [{ text: 'quoted', offset: 12, length: 6 }],
  }
  await store(file).put({ sessionId: 'session-a', draft, baseRev: 0 })
  const record = await store(file).get('session-a')
  assert.equal(record.draft.references[0].ref, 'README.md')
  assert.deepEqual(record.draft.command, { token: '/plan' })
  assert.equal(record.draft.quotes[0].text, 'quoted')
})

test('invalid session ids and oversized drafts are rejected', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const drafts = store(file)
  await assert.rejects(() => drafts.put({ sessionId: '../escape', draft: 'x' }), DraftStoreError)
  await assert.rejects(() => drafts.get(''), DraftStoreError)
  assert.throws(() => normalizeDraft({ text: 'x'.repeat(300_001), references: [] }), DraftStoreError)
  assert.throws(() => normalizeDraft(42), DraftStoreError)
})

test('pruning keeps the newest records', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  let clock = 1000
  const drafts = store(file, { maxDrafts: 2, now: () => (clock += 1000) })
  await drafts.put({ sessionId: 'session-a', draft: 'a', baseRev: 0 })
  await drafts.put({ sessionId: 'session-b', draft: 'b', baseRev: 0 })
  await drafts.put({ sessionId: 'session-c', draft: 'c', baseRev: 0 })
  const listed = await drafts.list()
  assert.deepEqual(listed.map((entry) => entry.sessionId), ['session-c', 'session-b'])
})

test('a corrupt storage file is quarantined instead of crashing the plugin', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(file, '{not json', 'utf8')
  const drafts = store(file)
  assert.equal(await drafts.get('session-a'), null)
  const names = await readdir(directory)
  assert.ok(names.some((name) => name.includes('.corrupt-')))
  await drafts.put({ sessionId: 'session-a', draft: 'ok', baseRev: 0 })
  assert.equal((await drafts.get('session-a')).draft.text, 'ok')
})

test('resolveHome honours DSH_HOME', () => {
  const configured = join(tmpdir(), 'dsh-home')
  assert.equal(resolveHome({ DSH_HOME: configured }), configured)
  assert.ok(resolveHome({}).endsWith('.dsh'))
})

async function withServer(storeInstance, run) {
  const handler = createHandler(storeInstance, silentLogger)
  const server = http.createServer((request, response) => { handler(request, response).catch(() => {}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('HTTP route saves, restores and clears a draft', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  await withServer(store(file), async (base) => {
    const health = await (await fetch(`${base}/dsh-draft/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.drafts, 0)

    const put = await (await fetch(`${base}/dsh-draft/put`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', draft: { text: 'draft body', references: [] }, baseRev: 0, writer: 'test' }),
    })).json()
    assert.equal(put.ok, true)
    assert.equal(put.rev, 1)

    const get = await (await fetch(`${base}/dsh-draft/get?sessionId=session-a`)).json()
    assert.equal(get.record.draft.text, 'draft body')

    const list = await (await fetch(`${base}/dsh-draft/list`)).json()
    assert.equal(list.drafts.length, 1)

    const removed = await (await fetch(`${base}/dsh-draft/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a', rev: 1 }),
    })).json()
    assert.equal(removed.deleted, true)
    const empty = await (await fetch(`${base}/dsh-draft/get?sessionId=session-a`)).json()
    assert.equal(empty.record, null)
  })
})

test('HTTP route rejects unsafe requests', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  await withServer(store(file), async (base) => {
    const wrongType = await fetch(`${base}/dsh-draft/put`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ sessionId: 'session-a', draft: 'x' }),
    })
    assert.equal(wrongType.status, 415)

    const badSession = await fetch(`${base}/dsh-draft/get?sessionId=bad%2Fsession`)
    assert.equal(badSession.status, 400)

    const missing = await fetch(`${base}/dsh-draft/nope`)
    assert.equal(missing.status, 404)

    const wrongMethod = await fetch(`${base}/dsh-draft/put`)
    assert.equal(wrongMethod.status, 405)

    const badJson = await fetch(`${base}/dsh-draft/put`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    assert.equal(badJson.status, 400)
  })
})

test('apply registers a prefixed route inside one effect and disposes it', async (t) => {
  const { directory, file } = await tempFile()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const registrations = []
  let disposer = null
  const ctx = {
    webServer: {
      register(route) {
        registrations.push(route)
        return () => { registrations.length = 0 }
      },
    },
    effect(callback) {
      disposer = callback()
    },
  }
  apply(ctx, { storagePath: file })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].kind, 'prefix')
  assert.equal(registrations[0].path, '/dsh-draft')
  assert.equal(typeof registrations[0].handler, 'function')
  assert.equal(typeof disposer, 'function')
  disposer()
  assert.equal(registrations.length, 0)
})
