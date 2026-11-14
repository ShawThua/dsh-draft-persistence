// @local/dsh-draft-persistence — Client half
//
// Mirrors the viewed Session's composer draft to the Host and restores it after
// a reload, a Session switch, or a Host restart.
//
// The composer shell (`ctx.conversation.input.shell(sessionId)`) is the only
// integration surface: it publishes `state` (draft text + revision) and accepts
// `setDraft(snapshot)`. A dock entry mounts for the viewed Session only, so no
// shell is created for Sessions the user never opens.
window.__ModuleLoader__.load({
  id: 'dsh-draft-persistence',
  factory(require) {
    const React = require('react')

    const API_PREFIX = '/dsh-draft'
    const LOCAL_AT_PREFIX = 'dsh-draft-persistence.saved-at'
    const WRITER_KEY = 'dsh-draft-persistence.writer'
    const DEFAULT_DEBOUNCE_MS = 700
    const DEFAULT_MAX_WAIT_MS = 3000
    // A Host copy written this much later than this browser's last successful
    // save is treated as a newer edit from another browser/device.
    const REMOTE_NEWER_MS = 1500

    function normalizeDraft(value) {
      if (typeof value === 'string') return { text: value, references: [] }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return { text: '', references: [] }
      const draft = { text: typeof value.text === 'string' ? value.text : '', references: [] }
      if (Array.isArray(value.references)) {
        for (const reference of value.references) {
          if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) continue
          if (typeof reference.offset !== 'number' || !Number.isFinite(reference.offset)) continue
          if (typeof reference.clipboardText !== 'string') continue
          draft.references.push({ ...reference })
        }
      }
      if (value.command !== null && typeof value.command === 'object'
        && typeof value.command.token === 'string' && value.command.token !== '') {
        draft.command = { token: value.command.token }
      }
      if (Array.isArray(value.quotes) && value.quotes.length > 0) {
        draft.quotes = value.quotes
          .filter((quote) => quote !== null && typeof quote === 'object' && !Array.isArray(quote))
          .map((quote) => ({ ...quote }))
      }
      return draft
    }

    function hasContent(draft) {
      return typeof draft?.text === 'string' && draft.text.trim() !== ''
    }

    function sameDraft(left, right) {
      return left === right || JSON.stringify(left) === JSON.stringify(right)
    }

    function safeStorage() {
      try {
        if (typeof localStorage !== 'undefined') return localStorage
      } catch { /* privacy modes can throw on access */ }
      return { getItem: () => null, setItem: () => {} }
    }

    function readWriterId() {
      try {
        const existing = sessionStorage.getItem(WRITER_KEY)
        if (typeof existing === 'string' && existing !== '') return existing
        const created = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID().slice(0, 8)
          : Math.random().toString(36).slice(2, 10)
        sessionStorage.setItem(WRITER_KEY, created)
        return created
      } catch {
        return 'unknown'
      }
    }

    async function requestJson(path, options) {
      const init = { method: options?.method ?? 'GET', credentials: 'same-origin', headers: {} }
      if (options?.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      if (options?.keepalive === true) init.keepalive = true
      const response = await fetch(API_PREFIX + path, init)
      if (!response.ok) throw new Error(`draft store HTTP ${response.status}`)
      return response.json()
    }

    /**
     * The testable core: mirrors one Session's composer draft to the Host.
     * @param {object} options
     * @param {string} options.sessionId
     * @param {() => any} options.getShell returns the resident composer shell
     * @param {(path: string, options?: object) => Promise<any>} options.request JSON transport
     * @param {Storage|{getItem: Function, setItem: Function}} [options.storage]
     * @param {(level: string, message: string, error?: unknown) => void} [options.log]
     * @param {() => number} [options.now]
     * @param {Function} [options.setTimer]
     * @param {Function} [options.clearTimer]
     * @param {number} [options.debounceMs]
     * @param {number} [options.maxWaitMs]
     * @param {string} [options.writer]
     */
    function createKeeper(options) {
      const sessionId = options.sessionId
      const request = options.request
      const storage = options.storage ?? { getItem: () => null, setItem: () => {} }
      const log = options.log ?? (() => {})
      const now = options.now ?? Date.now
      const setTimer = options.setTimer ?? setTimeout
      const clearTimer = options.clearTimer ?? clearTimeout
      const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : DEFAULT_DEBOUNCE_MS
      const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : DEFAULT_MAX_WAIT_MS
      const writer = typeof options.writer === 'string' ? options.writer : 'client'

      let shell = null
      let state = null
      let started = false
      let disposed = false
      let suppress = false
      let rev = 0
      let observed = null
      let observedRev = -1
      let lastSaved = null
      let lastSavedAt = 0
      let pending = null
      let timer = null
      let maxTimer = null
      let chain = Promise.resolve()
      let unsubscribe = null

      const localAtKey = `${LOCAL_AT_PREFIX}.${sessionId}`

      function readStoredAt() {
        try {
          const value = Number(storage.getItem(localAtKey))
          return Number.isFinite(value) ? value : 0
        } catch {
          return 0
        }
      }

      function writeStoredAt(value) {
        try { storage.setItem(localAtKey, String(value)) } catch { /* quota or privacy mode */ }
      }

      function readDraft() {
        try {
          return normalizeDraft(shell.draftSnapshot)
        } catch (error) {
          try { return normalizeDraft(state.getSnapshot().draft) } catch { return { text: '', references: [] } }
        }
      }

      function clearTimers() {
        if (timer !== null) { clearTimer(timer); timer = null }
        if (maxTimer !== null) { clearTimer(maxTimer); maxTimer = null }
      }

      function adopt(record) {
        const draft = normalizeDraft(record.draft)
        suppress = true
        try {
          shell.setDraft(draft)
        } catch (error) {
          log('warn', 'draft restore could not reach the editor', error)
        } finally {
          suppress = false
        }
        observed = draft
        observedRev = state.getSnapshot().draftRev
        lastSaved = draft
        lastSavedAt = Number.isFinite(record.updatedAt) ? record.updatedAt : now()
        rev = Number.isSafeInteger(record.rev) ? record.rev : rev
        writeStoredAt(lastSavedAt)
      }

      async function performSave(draft, keepalive) {
        if (!hasContent(draft)) {
          const response = await request('/delete', {
            method: 'POST',
            body: { sessionId, rev, writer },
            keepalive,
          })
          if (!response || response.ok !== true) throw new Error('draft delete was refused')
          rev = Number.isSafeInteger(response.rev) ? response.rev : rev
          lastSaved = draft
          lastSavedAt = now()
          writeStoredAt(lastSavedAt)
          return
        }

        let response = await request('/put', {
          method: 'POST',
          body: { sessionId, draft, baseRev: rev, writer },
          keepalive,
        })
        if (!response || response.ok !== true) throw new Error('draft put was refused')

        if (response.conflict === true) {
          const record = response.record
          if (record && typeof record === 'object') {
            const remote = normalizeDraft(record.draft)
            const remoteNewer = (record.updatedAt ?? 0) > lastSavedAt + REMOTE_NEWER_MS
            const unchangedLocally = lastSaved !== null && sameDraft(draft, lastSaved)
            if (remoteNewer && unchangedLocally && hasContent(remote) && !sameDraft(remote, draft)) {
              adopt(record)
              return
            }
          }
          // This browser holds the draft the user is editing right now: let it win.
          response = await request('/put', {
            method: 'POST',
            body: { sessionId, draft, baseRev: rev, writer, force: true },
            keepalive,
          })
          if (!response || response.ok !== true) throw new Error('draft put was refused')
        }

        rev = Number.isSafeInteger(response.rev) ? response.rev : rev
        lastSaved = draft
        lastSavedAt = Number.isFinite(response.updatedAt) ? response.updatedAt : now()
        writeStoredAt(lastSavedAt)
      }

      function flush(options2) {
        const job = pending
        if (job === null) return Promise.resolve()
        pending = null
        clearTimers()
        const keepalive = options2?.keepalive === true
        chain = chain.then(
          () => performSave(job.draft, keepalive),
          () => performSave(job.draft, keepalive),
        ).catch((error) => {
          log('warn', 'draft save failed', error)
          if (pending === null) pending = job
        })
        return chain
      }

      function queue(draft) {
        pending = { draft }
        if (!hasContent(draft)) {
          clearTimers()
          void flush()
          return
        }
        if (timer !== null) clearTimer(timer)
        timer = setTimer(() => {
          timer = null
          void flush()
        }, debounceMs)
        if (maxTimer === null) {
          maxTimer = setTimer(() => {
            maxTimer = null
            void flush()
          }, Math.max(debounceMs, maxWaitMs))
        }
      }

      function onState() {
        if (disposed || suppress || shell === null) return
        const snapshot = state.getSnapshot()
        if (snapshot.draftRev === observedRev) return
        const draft = readDraft()
        if (observed !== null && sameDraft(draft, observed)) {
          observedRev = snapshot.draftRev
          return
        }
        observed = draft
        observedRev = snapshot.draftRev
        queue(draft)
      }

      async function restore(revAtMount) {
        let record = null
        try {
          const response = await request(`/get?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET' })
          record = response && response.ok === true ? response.record ?? null : null
        } catch (error) {
          log('warn', 'draft restore failed', error)
          return
        }
        if (disposed || shell === null) return
        const current = readDraft()
        const edited = state.getSnapshot().draftRev !== revAtMount
        const storedAt = readStoredAt()

        if (record && typeof record === 'object') {
          const remote = normalizeDraft(record.draft)
          if (hasContent(remote)) {
            rev = Number.isSafeInteger(record.rev) ? record.rev : rev
            const remoteNewer = (record.updatedAt ?? 0) > storedAt + REMOTE_NEWER_MS
            if (!edited && !hasContent(current)) {
              adopt(record)
              return
            }
            if (!edited && remoteNewer && !sameDraft(remote, current)) {
              adopt(record)
              return
            }
          }
        }

        if (hasContent(current)) {
          lastSaved = null
          pending = { draft: current }
          await flush()
        }
      }

      function start() {
        if (started || disposed) return
        started = true
        try {
          shell = options.getShell()
        } catch (error) {
          shell = null
          log('warn', 'draft keeper could not resolve the composer shell', error)
        }
        if (!shell || !shell.state) {
          log('warn', 'draft keeper found no composer shell for this Session')
          return
        }
        state = shell.state
        const revAtMount = state.getSnapshot().draftRev
        observed = readDraft()
        observedRev = revAtMount
        unsubscribe = state.subscribe(onState)
        Promise.resolve().then(() => restore(revAtMount)).catch((error) => {
          log('warn', 'draft restore failed', error)
        })
      }

      function dispose() {
        if (disposed) return
        clearTimers()
        if (unsubscribe !== null) {
          try { unsubscribe() } catch { /* already torn down */ }
          unsubscribe = null
        }
        const job = pending
        pending = null
        disposed = true
        if (job === null) return
        try {
          if (hasContent(job.draft)) {
            void request('/put', {
              method: 'POST',
              body: { sessionId, draft: job.draft, baseRev: rev, writer },
              keepalive: true,
            }).catch(() => {})
          } else {
            void request('/delete', {
              method: 'POST',
              body: { sessionId, rev, writer },
              keepalive: true,
            }).catch(() => {})
          }
        } catch { /* unload paths may refuse network calls */ }
      }

      function pagehide() {
        if (disposed) return
        clearTimers()
        const job = pending
        pending = null
        if (job === null) return
        try {
          if (hasContent(job.draft)) {
            void request('/put', {
              method: 'POST',
              body: { sessionId, draft: job.draft, baseRev: rev, writer },
              keepalive: true,
            }).catch(() => {})
          } else {
            void request('/delete', {
              method: 'POST',
              body: { sessionId, rev, writer },
              keepalive: true,
            }).catch(() => {})
          }
        } catch { /* unload paths may refuse network calls */ }
      }

      function flushNow() {
        if (disposed) return
        void flush({ keepalive: true })
      }

      return {
        start,
        dispose,
        pagehide,
        flushNow,
        getState: () => ({ rev, observed, lastSaved, lastSavedAt, pending, disposed }),
      }
    }

    let rootCtx = null

    function DraftKeeper(props) {
      const sessionId = props && props.sessionId
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '' || rootCtx === null) return undefined
        const keeper = createKeeper({
          sessionId,
          getShell: () => {
            const conversation = typeof rootCtx.get === 'function' ? rootCtx.get('conversation') : undefined
            if (!conversation || !conversation.input) return undefined
            return conversation.input.shell(sessionId)
          },
          request: requestJson,
          storage: safeStorage(),
          log: (level, message, error) => {
            if (level === 'warn' || level === 'error') console.warn('[dsh-draft]', message, error === undefined ? '' : error)
          },
          writer: readWriterId(),
        })
        keeper.start()
        const onVisibility = () => {
          try {
            if (document.visibilityState === 'hidden') keeper.flushNow()
          } catch { /* no document */ }
        }
        window.addEventListener('pagehide', keeper.pagehide)
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          window.removeEventListener('pagehide', keeper.pagehide)
          document.removeEventListener('visibilitychange', onVisibility)
          keeper.dispose()
        }
      }, [sessionId])
      return null
    }

    const inject = ['slots']

    function apply(ctx) {
      rootCtx = ctx
      const slots = ctx && (ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined))
      if (!slots) return
      const register = () => slots.inject('conversation.input.dock', () => slots.register({
        name: 'conversation.input.dock',
        id: 'draft-persistence',
        order: 90,
      }, DraftKeeper))
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-draft-persistence: draft keeper')
      else register()
    }

    const exports = {
      inject,
      apply,
      __test: { createKeeper, normalizeDraft, hasContent, sameDraft },
    }
    return exports
  },
})

