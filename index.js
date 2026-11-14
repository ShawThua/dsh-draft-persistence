// @local/dsh-draft-persistence — Host half
//
// Stores unsent composer drafts per Session in
//   $DSH_HOME/storages/dsh-draft/drafts.json
// and serves a loopback-only route (/dsh-draft/*) that the Client half uses to
// save, restore, and clear one Session's draft.
//
// Design notes (kept deliberately dependency-free):
// - No @deepseek-ai imports: the route is registered through the public
//   `webServer` service, the same mechanism the installed dsh-steer plugin uses.
// - Every write is serialized and committed with write-temp + rename, so a
//   crash or a full disk cannot leave a half-written JSON file.
// - The route is loopback-only and POST bodies must be `application/json`
//   (a cross-origin write would need a CORS preflight this route never answers).
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { appendFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

export const name = 'dsh-draft-persistence'
export const inject = ['webServer']

const API_PREFIX = '/dsh-draft'
const STORAGE_VERSION = 1
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 300_000
const MAX_REFERENCES = 400
const MAX_DRAFTS = 400
const DEFAULT_CONFIG = Object.freeze({})

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u

/** Domain failure with a stable code; the HTTP layer turns it into a 4xx. */
export class DraftStoreError extends Error {
  /** @param {string} message @param {string} code @param {number} [status] */
  constructor(message, code, status = 400) {
    super(message)
    this.name = 'DraftStoreError'
    this.code = code
    this.status = status
  }
}

/** @returns {string} the effective DSH home directory. */
export function resolveHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

/**
 * Validate a Session id used as a storage key.
 * @param {unknown} value
 * @returns {string}
 */
export function requireSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new DraftStoreError('sessionId is missing or malformed', 'DRAFT_INVALID_SESSION', 400)
  }
  return value
}

function optionalString(value, field, limit) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new DraftStoreError(`${field} must be a string`, 'DRAFT_INVALID_DRAFT')
  if (value.length > limit) throw new DraftStoreError(`${field} is too long`, 'DRAFT_INVALID_DRAFT', 413)
  return value
}

/**
 * Normalize a Client draft (plain text or the semantic `DraftSnapshot`) into the
 * JSON shape stored on disk. Unknown or unsafe fields are dropped so the file
 * stays a plain, versioned document.
 * @param {unknown} value
 * @returns {{text: string, references: object[], command?: {token: string}, quotes?: object[]}}
 */
export function normalizeDraft(value) {
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT_CHARS) throw new DraftStoreError('draft text is too long', 'DRAFT_INVALID_DRAFT', 413)
    return { text: value, references: [] }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DraftStoreError('draft must be a string or an object', 'DRAFT_INVALID_DRAFT')
  }
  const text = optionalString(value.text, 'draft.text', MAX_TEXT_CHARS) ?? ''
  const sourceReferences = Array.isArray(value.references) ? value.references : []
  if (sourceReferences.length > MAX_REFERENCES) {
    throw new DraftStoreError('draft has too many references', 'DRAFT_INVALID_DRAFT', 413)
  }
  const references = []
  for (const reference of sourceReferences) {
    if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) continue
    if (typeof reference.offset !== 'number' || !Number.isFinite(reference.offset)) continue
    if (typeof reference.clipboardText !== 'string') continue
    references.push({ ...reference, offset: Math.max(0, Math.trunc(reference.offset)) })
  }
  /** @type {{text: string, references: object[], command?: {token: string}, quotes?: object[]}} */
  const draft = { text, references }
  if (value.command !== undefined && value.command !== null && typeof value.command === 'object'
    && typeof value.command.token === 'string' && value.command.token !== '') {
    draft.command = { token: value.command.token }
  }
  if (Array.isArray(value.quotes) && value.quotes.length > 0) {
    draft.quotes = value.quotes.filter((quote) => quote !== null && typeof quote === 'object' && !Array.isArray(quote)).map((quote) => ({ ...quote }))
  }
  return draft
}

/** @param {object} draft @returns {boolean} whether the draft carries anything worth restoring. */
export function hasContent(draft) {
  return typeof draft?.text === 'string' && draft.text.trim() !== ''
}

function sameDraft(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Append-only JSONL diagnostics sink; failures never disturb the plugin. */
function createLogger(directory) {
  const file = join(directory, 'persist.log')
  let ready = false
  let rotating = false

  function rotateIfNeeded() {
    if (rotating) return
    rotating = true
    stat(file).then((info) => {
      if (info.size < 1024 * 1024) return
      return rename(file, `${file}.1`).catch(() => {})
    }).catch(() => {}).finally(() => { rotating = false })
  }

  function write(level, message, extra) {
    const line = `${new Date().toISOString()} ${level} ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}\n`
    if (level !== 'debug') {
      const sink = level === 'error' ? console.error : console.warn
      sink('[dsh-draft]', message, extra === undefined ? '' : extra)
    }
    const start = ready ? Promise.resolve() : mkdir(directory, { recursive: true }).then(() => { ready = true; rotateIfNeeded() })
    start.then(() => appendFile(file, line, 'utf8')).catch(() => {})
  }

  return {
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    debug: (message, extra) => write('debug', message, extra),
  }
}

/**
 * Serialized, atomically persisted map of Session id -> draft record.
 * Failures never corrupt the stored document; the previous file survives.
 */
export class DraftStore {
  #filePath
  #maxDrafts
  #now
  #logger
  #drafts
  #queue = Promise.resolve()
  #loading

  /**
   * @param {object} options
   * @param {string} options.filePath absolute JSON path
   * @param {number} [options.maxDrafts]
   * @param {() => number} [options.now]
   * @param {object} [options.logger]
   */
  constructor(options) {
    if (typeof options?.filePath !== 'string' || options.filePath === '') {
      throw new DraftStoreError('filePath is required', 'DRAFT_INVALID_CONFIG')
    }
    this.#filePath = options.filePath
    this.#maxDrafts = Number.isSafeInteger(options.maxDrafts) && options.maxDrafts > 0 ? options.maxDrafts : MAX_DRAFTS
    this.#now = typeof options.now === 'function' ? options.now : Date.now
    this.#logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} }
  }

  get filePath() {
    return this.#filePath
  }

  /** Serialize one operation behind every earlier one. */
  #enqueue(operation) {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  async #loaded() {
    if (this.#drafts !== undefined) return this.#drafts
    if (this.#loading !== undefined) return this.#loading
    this.#loading = this.#read()
    try {
      this.#drafts = await this.#loading
      return this.#drafts
    } finally {
      this.#loading = undefined
    }
  }

  async #read() {
    let contents
    try {
      contents = await readFile(this.#filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return new Map()
      throw error
    }
    try {
      const parsed = JSON.parse(contents)
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== STORAGE_VERSION || parsed.drafts === null || typeof parsed.drafts !== 'object') {
        throw new Error('unsupported storage layout')
      }
      const drafts = new Map()
      for (const [sessionId, record] of Object.entries(parsed.drafts)) {
        if (!SESSION_ID_PATTERN.test(sessionId)) continue
        if (record === null || typeof record !== 'object') continue
        if (!Number.isSafeInteger(record.rev) || record.rev < 1) continue
        const draft = normalizeDraft(record.draft)
        drafts.set(sessionId, {
          draft,
          rev: record.rev,
          updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
          writer: typeof record.writer === 'string' ? record.writer : '',
        })
      }
      return drafts
    } catch (error) {
      const quarantine = `${this.#filePath}.corrupt-${Date.now()}.json`
      this.#logger.error('storage.corrupt', { message: error instanceof Error ? error.message : String(error), quarantine })
      await rename(this.#filePath, quarantine).catch(() => {})
      return new Map()
    }
  }

  async #commit(drafts) {
    const document = { version: STORAGE_VERSION, drafts: Object.fromEntries(drafts) }
    const directory = dirname(this.#filePath)
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.${Date.now()}-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(document), { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, this.#filePath)
    } finally {
      await unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error })
    }
    this.#drafts = drafts
  }

  #prune(drafts) {
    if (drafts.size <= this.#maxDrafts) return drafts
    const ordered = [...drafts.entries()].sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, this.#maxDrafts)
    return new Map(ordered)
  }

  /** Warm the cache so the first request is not the first disk read. */
  ensureLoaded() {
    return this.#enqueue(async () => { await this.#loaded() })
  }

  stats() {
    return this.#enqueue(async () => {
      const drafts = await this.#loaded()
      let chars = 0
      for (const record of drafts.values()) chars += record.draft.text.length
      return { drafts: drafts.size, chars, file: this.#filePath }
    })
  }

  /** @param {string} sessionId */
  get(sessionId) {
    return this.#enqueue(async () => {
      const drafts = await this.#loaded()
      const record = drafts.get(requireSessionId(sessionId))
      return record === undefined ? null : { sessionId, ...structuredClone(record) }
    })
  }

  /** @returns {Promise<Array<{sessionId: string, rev: number, updatedAt: number, chars: number, preview: string}>>} */
  list() {
    return this.#enqueue(async () => {
      const drafts = await this.#loaded()
      return [...drafts.entries()]
        .map(([sessionId, record]) => ({
          sessionId,
          rev: record.rev,
          updatedAt: record.updatedAt,
          chars: record.draft.text.length,
          preview: record.draft.text.slice(0, 80),
        }))
        .sort((left, right) => right.updatedAt - left.updatedAt)
    })
  }

  /**
   * Optimistic write: `baseRev` is the revision the Client last saw. A mismatch
   * returns the current record instead of overwriting it, unless `force` is set.
   * @param {{sessionId: string, draft: unknown, baseRev?: number, writer?: string, force?: boolean}} request
   */
  put(request) {
    return this.#enqueue(async () => {
      const sessionId = requireSessionId(request?.sessionId)
      const draft = normalizeDraft(request?.draft)
      const baseRev = Number.isSafeInteger(request?.baseRev) && request.baseRev >= 0 ? request.baseRev : 0
      const writer = typeof request?.writer === 'string' ? request.writer.slice(0, 120) : ''
      const force = request?.force === true
      const drafts = new Map(await this.#loaded())
      const current = drafts.get(sessionId)
      if (current !== undefined && sameDraft(current.draft, draft)) {
        return { ok: true, rev: current.rev, updatedAt: current.updatedAt, unchanged: true }
      }
      if (current !== undefined && !force && baseRev !== current.rev) {
        return { ok: true, conflict: true, record: { sessionId, ...structuredClone(current) } }
      }
      if (current === undefined && baseRev !== 0 && !force) {
        return { ok: true, conflict: true, record: null }
      }
      const record = {
        draft,
        rev: (current?.rev ?? 0) + 1,
        updatedAt: Math.max(this.#now(), current?.updatedAt ?? 0),
        writer,
      }
      drafts.set(sessionId, record)
      await this.#commit(this.#prune(drafts))
      return { ok: true, rev: record.rev, updatedAt: record.updatedAt }
    })
  }

  /**
   * Drop one Session's draft. Deletion always wins (the user emptied the
   * composer); `rev` is accepted for diagnostics only.
   * @param {{sessionId: string, rev?: number, writer?: string}} request
   */
  delete(request) {
    return this.#enqueue(async () => {
      const sessionId = requireSessionId(request?.sessionId)
      const drafts = new Map(await this.#loaded())
      if (!drafts.delete(sessionId)) return { ok: true, deleted: false }
      await this.#commit(drafts)
      return { ok: true, deleted: true }
    })
  }
}

function isLoopback(request) {
  const address = request?.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

async function readJsonBody(request) {
  const type = String(request.headers['content-type'] ?? '')
  if (!/application\/json/i.test(type)) {
    throw new DraftStoreError('content-type must be application/json', 'DRAFT_UNSUPPORTED_MEDIA', 415)
  }
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new DraftStoreError('request body is too large', 'DRAFT_PAYLOAD_TOO_LARGE', 413)
    chunks.push(chunk)
  }
  if (total === 0) throw new DraftStoreError('request body is empty', 'DRAFT_INVALID_BODY')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new DraftStoreError('request body is not valid JSON', 'DRAFT_INVALID_BODY')
  }
}

/**
 * HTTP handler for the `/dsh-draft` prefix route.
 * @param {DraftStore} store
 * @param {{warn: Function, error: Function}} logger
 */
export function createHandler(store, logger) {
  return async function handler(request, response) {
    try {
      if (!isLoopback(request)) return sendJson(response, 403, { ok: false, error: 'forbidden' })
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const route = url.pathname

      if (route === `${API_PREFIX}/health`) {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        return sendJson(response, 200, { ok: true, ...(await store.stats()) })
      }

      if (route === `${API_PREFIX}/get`) {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        const sessionId = requireSessionId(url.searchParams.get('sessionId') ?? '')
        return sendJson(response, 200, { ok: true, record: await store.get(sessionId) })
      }

      if (route === `${API_PREFIX}/list`) {
        if (request.method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        return sendJson(response, 200, { ok: true, drafts: await store.list() })
      }

      if (route === `${API_PREFIX}/put`) {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        const body = await readJsonBody(request)
        return sendJson(response, 200, await store.put(body))
      }

      if (route === `${API_PREFIX}/delete`) {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        const body = await readJsonBody(request)
        return sendJson(response, 200, await store.delete(body))
      }

      return sendJson(response, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      if (error instanceof DraftStoreError) {
        return sendJson(response, error.status, { ok: false, error: error.code, message: error.message })
      }
      logger?.error('request.failed', { message: error instanceof Error ? error.message : String(error) })
      return sendJson(response, 500, { ok: false, error: 'internal', message: 'draft store failed' })
    }
  }
}

/**
 * Host plugin entry. Registers the loopback route and owns the draft store.
 * @param {any} ctx
 * @param {{storagePath?: string, maxDrafts?: number} | undefined} config
 */
export function apply(ctx, config = DEFAULT_CONFIG) {
  const home = resolveHome()
  const configuredPath = typeof config?.storagePath === 'string' ? config.storagePath.trim() : ''
  const filePath = configuredPath === ''
    ? join(home, 'storages', 'dsh-draft', 'drafts.json')
    : (isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath))
  const logger = createLogger(join(home, 'logs', 'dsh-draft'))
  const store = new DraftStore({
    filePath,
    maxDrafts: config?.maxDrafts,
    logger,
  })
  logger.info('plugin.ready', { file: filePath })
  store.ensureLoaded().catch((error) => {
    logger.error('storage.loadFailed', { message: error instanceof Error ? error.message : String(error) })
  })

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: createHandler(store, logger),
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        logger.warn('route.disposeFailed', { message: error instanceof Error ? error.message : String(error) })
      }
    }
  }, 'dsh-draft-persistence: http route')
}
