import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

const ORCA_MODEL_ID = 'orcarouter-qwen3.8-27b-uncensored-q4-k-m'

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback
}

function requiredArgument(name) {
  const value = argument(name).trim()
  if (!value) throw new Error(`Missing --${name}.`)
  return value
}

const port = Number(argument('port', '9229'))
const baseUrl = requiredArgument('base-url').replace(/\/+$/, '')
const deviceKeyFile = requiredArgument('device-key-file')
const outputFile = resolve(requiredArgument('output'))
const prompt = argument('prompt', 'Antworte exakt mit: LUCZOR_LOCAL_E2E_OK').trim()
const timeoutMs = Number(argument('timeout-ms', String(12 * 60_000)))
const interactive = process.argv.includes('--interactive')
const smokeProjectId = `local-model-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`

if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP port.')
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 30 * 60_000) {
  throw new Error('Invalid timeout.')
}
if (!isAbsolute(deviceKeyFile)) throw new Error('The device-key file path must be absolute.')
const parsedBaseUrl = new URL(baseUrl)
if (parsedBaseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsedBaseUrl.hostname)) {
  throw new Error('The smoke test accepts only a loopback HTTP control plane.')
}
const deviceKey = readFileSync(deviceKeyFile, 'utf8').trim()
if (!deviceKey || deviceKey.length > 4096 || /[\u0000-\u001f\u007f]/u.test(deviceKey)) {
  throw new Error('The device-key file is empty or invalid.')
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

async function discoverPage() {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find(
          target =>
            target.type === 'page' &&
            typeof target.webSocketDebuggerUrl === 'string' &&
            (String(target.url).startsWith('http://localhost:1420') ||
              String(target.url).startsWith('http://127.0.0.1:1420') ||
              String(target.url).startsWith('tauri://localhost') ||
              String(target.url).startsWith('http://tauri.localhost'))
        )
        if (page) return page
      }
    } catch {
      // Tauri/WebView2 is still starting.
    }
    await delay(500)
  }
  throw new Error('No Luczor WebView appeared on the configured CDP endpoint.')
}

class CdpSession {
  constructor(url) {
    this.nextId = 1
    this.pending = new Map()
    this.dialogs = []
    this.closedError = null
    this.socket = new WebSocket(url)
  }

  async connect() {
    await new Promise((resolveConnect, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timed out.')), 30_000)
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolveConnect()
        },
        { once: true }
      )
      this.socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('CDP WebSocket connection failed.'))
        },
        { once: true }
      )
    })
    this.socket.addEventListener('message', event => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        this.rejectPending(new Error('CDP emitted invalid JSON.'))
        return
      }
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message}`))
        else pending.resolve(message.result)
        return
      }
      if (message.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(String(message.params?.message ?? ''))
        void this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined)
      }
    })
    this.socket.addEventListener('error', () => {
      this.rejectPending(new Error('CDP WebSocket failed.'))
    })
    this.socket.addEventListener('close', () => {
      this.rejectPending(new Error('CDP WebSocket closed.'))
    })
  }

  rejectPending(error) {
    this.closedError = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  send(method, params = {}, requestTimeoutMs = 30_000) {
    const id = this.nextId++
    return new Promise((resolveRequest, reject) => {
      if (this.closedError || this.socket.readyState !== WebSocket.OPEN) {
        reject(this.closedError ?? new Error('CDP WebSocket is not open.'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out.`))
      }, requestTimeoutMs)
      this.pending.set(id, { resolve: resolveRequest, reject, method, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const details = result.exceptionDetails
      const description =
        details.exception?.description ??
        details.exception?.value ??
        details.text ??
        result.result?.description ??
        'Evaluation failed in the Luczor WebView.'
      throw new Error(String(description))
    }
    return result.result?.value
  }

  close() {
    this.rejectPending(new Error('CDP session closed.'))
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close()
    }
  }
}

async function waitFor(session, description, probe, timeout = timeoutMs, retryEvaluationErrors = false) {
  const deadline = Date.now() + timeout
  let lastValue
  while (Date.now() < deadline) {
    let evaluated = false
    try {
      lastValue = await session.evaluate(probe)
      evaluated = true
    } catch (error) {
      if (!retryEvaluationErrors || session.closedError) throw error
      lastValue = error instanceof Error ? error.message : String(error)
    }
    if (evaluated && lastValue) return lastValue
    await delay(500)
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`)
}

function jsonLiteral(value) {
  return JSON.stringify(String(value))
}

async function waitForInteractiveExit() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await terminal.question(
      '\nLuczor bleibt für den manuellen Test geöffnet. Zum kontrollierten Beenden und Aufräumen Enter drücken.\n'
    )
  } finally {
    terminal.close()
  }
}

const page = await discoverPage()
const session = new CdpSession(page.webSocketDebuggerUrl)
await session.connect()
await session.send('Runtime.enable')
await session.send('Page.enable')

let settingsSnapshot = null
let previousDeviceKey = null
let previousDeviceKeyCaptured = false
let previousProjectId = null
let primaryError = null
const cleanupErrors = []

try {
  await waitFor(session, 'the Luczor composer', `Boolean(document.querySelector('.composer__input'))`)
  const captured = await session.evaluate(`(async () => {
    const { state } = await import('/src/state/store.ts')
    const priorKey = await window.__TAURI_INTERNALS__.invoke('device_key_get')
    return {
      previousProjectId: state.global.ui?.lastProjectId ?? null,
      previousDeviceKey: priorKey,
      previousDeviceKeyCaptured: true,
    }
  })()`)
  previousProjectId = captured?.previousProjectId ?? null
  previousDeviceKey = captured?.previousDeviceKey ?? null
  previousDeviceKeyCaptured = captured?.previousDeviceKeyCaptured === true
  if (!previousDeviceKeyCaptured) {
    throw new Error('The pre-test state could not be snapshotted.')
  }
  settingsSnapshot = await session.evaluate(`(async () => {
    const profile = await import('/src/services/inference/localModelE2eProfile.ts')
    return profile.snapshotLocalModelE2eSettings()
  })()`)
  if (!Array.isArray(settingsSnapshot)) throw new Error('The settings snapshot is invalid.')
  await session.evaluate(`(async () => {
    const profile = await import('/src/services/inference/localModelE2eProfile.ts')
    await profile.applyLocalModelE2eSettings(${jsonLiteral(baseUrl)})
    return true
  })()`)
  await session.evaluate(`(async () => {
    await window.__TAURI_INTERNALS__.invoke('device_key_set', {
      payload: { value: ${jsonLiteral(deviceKey)} }
    })
    const verifiedKey = await window.__TAURI_INTERNALS__.invoke('device_key_get')
    if (verifiedKey !== ${jsonLiteral(deviceKey)}) throw new Error('The isolated Device Key was not persisted.')
    return true
  })()`)

  // Reload after setting the loopback endpoint and protected test credential.
  // This makes startup policy acceptance and the in-memory mode deterministic.
  await session.send('Page.reload', { ignoreCache: true })
  await waitFor(
    session,
    'the reloaded deterministic Luczor profile',
    `(async () => {
      if (!document.querySelector('.composer__input')) return false
      const profile = await import('/src/services/inference/localModelE2eProfile.ts')
      const mode = document.querySelector('.mode-toggle')?.textContent?.trim()
      const key = await window.__TAURI_INTERNALS__.invoke('device_key_get')
      return mode === 'Beobachten' && key === ${jsonLiteral(deviceKey)} &&
        await profile.verifyLocalModelE2eSettings(${jsonLiteral(baseUrl)})
    })()`,
    60_000,
    true
  )

  const readiness = await waitFor(
    session,
    'signed local-model readiness',
    `(async () => {
      try {
        const status = await window.__TAURI_INTERNALS__.invoke('local_model_status')
        const ready = status?.manifestAvailable === true && status?.readiness?.some(item =>
          item.ready === true && item.modelReleaseId === ${jsonLiteral(ORCA_MODEL_ID)})
        return ready ? status : null
      } catch { return null }
    })()`,
    timeoutMs
  )
  const hardware = await session.evaluate(
    `(async () => window.__TAURI_INTERNALS__.invoke('local_model_hardware_snapshot'))()`
  )

  // Luczor currently keeps one chat per project. Immediately before the
  // measured turn, select a new dedicated test project so persisted chats and
  // any parallel input during preparation remain intact but cannot enter this
  // request. The one resulting assistant message is the generated greeting.
  const freshChat = await session.evaluate(`(async () => {
    const { mutations, state } = await import('/src/state/store.ts')
    const projectId = ${jsonLiteral(smokeProjectId)}
    const existed = state.projects.some(project => project.id === projectId)
    const messagesBefore = state.messages.filter(message => message.projectId === projectId).length
    if (!existed) mutations.addProject({ id: projectId, name: 'Local Model E2E' })
    await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
    const messages = state.messages.filter(message => message.projectId === projectId)
    return {
      projectId,
      existed,
      messagesBefore,
      activeProjectId: state.global.ui?.lastProjectId ?? null,
      messages: messages.map(message => ({ role: message.role, content: message.content, visibility: message.visibility }))
    }
  })()`)
  const freshChatIsolated =
    freshChat?.existed === false &&
    freshChat?.messagesBefore === 0 &&
    freshChat?.activeProjectId === smokeProjectId &&
    freshChat?.messages?.length === 1 &&
    freshChat.messages[0]?.role === 'assistant' &&
    freshChat.messages[0]?.visibility === 'visible'
  if (!freshChatIsolated) {
    throw new Error(`The smoke chat is not fresh: ${JSON.stringify(freshChat)}`)
  }
  await waitFor(
    session,
    'the dedicated fresh smoke chat',
    `(() => {
      const title = document.querySelector('.header__title')?.textContent?.trim()
      return title === 'Local Model E2E' && document.querySelectorAll('.msg--assistant').length === 1 &&
        document.querySelectorAll('.msg--user').length === 0
    })()`,
    30_000
  )

  const baselineAssistantCount = await session.evaluate(`[...document.querySelectorAll('.msg--assistant')].length`)
  const startedAt = Date.now()
  await session.evaluate(`(() => {
    const input = document.querySelector('.composer__input')
    if (!input) throw new Error('Composer is unavailable.')
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    descriptor.set.call(input, ${jsonLiteral(prompt)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await waitFor(
    session,
    'the prompt to reach Vue and enable Send',
    `(() => {
      const input = document.querySelector('.composer__input')
      const send = document.querySelector('.send-btn')
      return input?.value === ${jsonLiteral(prompt)} && Boolean(send) && send.disabled === false
    })()`,
    30_000
  )
  const preTurnState = await session.evaluate(`(async () => {
    const { state } = await import('/src/state/store.ts')
    const projectId = ${jsonLiteral(smokeProjectId)}
    const messages = state.messages.filter(message => message.projectId === projectId)
    return {
      activeProjectId: state.global.ui?.lastProjectId ?? null,
      messageCount: messages.length,
      assistantCount: messages.filter(message => message.role === 'assistant').length,
      userCount: messages.filter(message => message.role === 'user').length,
    }
  })()`)
  if (
    preTurnState?.activeProjectId !== smokeProjectId ||
    preTurnState?.messageCount !== 1 ||
    preTurnState?.assistantCount !== 1 ||
    preTurnState?.userCount !== 0
  ) {
    throw new Error(`The smoke chat changed before the measured turn: ${JSON.stringify(preTurnState)}`)
  }
  await session.evaluate(`(() => {
    const send = document.querySelector('.send-btn')
    if (!send || send.disabled) throw new Error('Send button is unavailable.')
    send.click()
    return true
  })()`)

  const answer = await waitFor(
    session,
    'a completed local assistant answer',
    `(() => {
      const messages = [...document.querySelectorAll('.msg--assistant')]
      if (messages.length <= ${baselineAssistantCount}) return null
      const message = messages.slice(${baselineAssistantCount}).at(-1)
      if (!message || message.querySelector('.typing, .stream-caret')) return null
      const content = message.querySelector('.answer__summary')?.textContent?.trim() ?? ''
      const modelLabel = message.querySelector('.msg__model')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''
      if (content.startsWith('[Fehler]')) return { error: content }
      return content && modelLabel ? { content, modelLabel } : null
    })()`,
    timeoutMs
  )
  const latencyMs = Date.now() - startedAt

  if (answer.error) {
    const failureStatus = await session.evaluate(`(async () => {
      try {
        const status = await window.__TAURI_INTERNALS__.invoke('local_model_status')
        return { state: status?.state ?? null, reasonCode: status?.reasonCode ?? null }
      } catch { return null }
    })()`)
    throw new Error(
      `Luczor chat failed (${failureStatus?.reasonCode ?? failureStatus?.state ?? 'unknown'}): ${answer.error}`
    )
  }
  if (!answer.modelLabel.includes('local') || !answer.modelLabel.includes(ORCA_MODEL_ID)) {
    throw new Error(`Unexpected inference route: ${answer.modelLabel || 'missing label'}`)
  }
  if (answer.content.trim() !== 'LUCZOR_LOCAL_E2E_OK') {
    throw new Error(`The local model did not return the smoke marker: ${answer.content.slice(0, 240)}`)
  }
  if (session.dialogs.length > 0) {
    throw new Error('A confirmation dialog opened; the test did not stay on the autonomous local route.')
  }
  const completedChat = await session.evaluate(`(async () => {
    const { state } = await import('/src/state/store.ts')
    const projectId = ${jsonLiteral(smokeProjectId)}
    const messages = state.messages.filter(message => message.projectId === projectId && message.visibility !== 'hidden')
    return {
      activeProjectId: state.global.ui?.lastProjectId ?? null,
      roles: messages.map(message => message.role),
      userMessages: messages.filter(message => message.role === 'user').map(message => message.content),
      assistantMessages: messages.filter(message => message.role === 'assistant').map(message => message.content),
    }
  })()`)
  const completedChatIsolated =
    completedChat?.activeProjectId === smokeProjectId &&
    JSON.stringify(completedChat?.roles) === JSON.stringify(['assistant', 'user', 'assistant']) &&
    JSON.stringify(completedChat?.userMessages) === JSON.stringify([prompt]) &&
    completedChat?.assistantMessages?.[1]?.trim() === 'LUCZOR_LOCAL_E2E_OK'
  if (!completedChatIsolated) {
    throw new Error(`The completed smoke chat is not isolated: ${JSON.stringify(completedChat)}`)
  }

  const report = {
    schema_version: 1,
    completed_at: new Date().toISOString(),
    result: 'passed',
    route: 'local_llama_cpp',
    model_id: ORCA_MODEL_ID,
    model_label: answer.modelLabel,
    prompt,
    answer: answer.content,
    latency_ms: latencyMs,
    control_plane: baseUrl,
    native_status: readiness,
    native_hardware: hardware,
    external_confirmation_dialogs: session.dialogs.length,
    fresh_chat: {
      project_id: smokeProjectId,
      preexisting_messages: freshChat.messagesBefore,
      initial_messages: freshChat.messages.length,
      roles_after_completion: completedChat.roles,
    },
  }
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  process.stdout.write(
    `${JSON.stringify({ result: 'passed', model: ORCA_MODEL_ID, latency_ms: latencyMs, output: outputFile, interactive })}\n`
  )
  if (interactive) await waitForInteractiveExit()
} catch (error) {
  primaryError = error
} finally {
  if (previousProjectId) {
    try {
      const restoredProject = await session.evaluate(`(async () => {
        const { mutations, state } = await import('/src/state/store.ts')
        const projectId = ${jsonLiteral(previousProjectId)}
        if (!state.projects.some(project => project.id === projectId)) return false
        mutations.setActiveProject(projectId)
        await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))
        return state.global.ui?.lastProjectId === projectId
      })()`)
      if (!restoredProject) throw new Error('The previous project could not be restored.')
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (Array.isArray(settingsSnapshot)) {
    try {
      const restoredSettings = await session.evaluate(`(async () => {
        const profile = await import('/src/services/inference/localModelE2eProfile.ts')
        const snapshot = ${JSON.stringify(settingsSnapshot)}
        await profile.restoreLocalModelE2eSettings(snapshot)
        return profile.matchesLocalModelE2eSettingsSnapshot(snapshot)
      })()`)
      if (!restoredSettings) throw new Error('The previous settings could not be verified.')
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (previousDeviceKeyCaptured) {
    try {
      const restoredDeviceKey = await session.evaluate(`(async () => {
        const priorKey = ${JSON.stringify(previousDeviceKey)}
        if (typeof priorKey === 'string' && priorKey.length > 0) {
          await window.__TAURI_INTERNALS__.invoke('device_key_set', { payload: { value: priorKey } })
        } else {
          await window.__TAURI_INTERNALS__.invoke('device_key_delete')
        }
        const verified = await window.__TAURI_INTERNALS__.invoke('device_key_get')
        return typeof priorKey === 'string' && priorKey.length > 0 ? verified === priorKey : verified == null
      })()`)
      if (!restoredDeviceKey) throw new Error('The previous Device Key could not be verified.')
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  session.close()
}

if (primaryError && cleanupErrors.length > 0) {
  throw new AggregateError(
    [primaryError, ...cleanupErrors.map(message => new Error(message))],
    'Smoke failed and cleanup was incomplete.'
  )
}
if (primaryError) throw primaryError
if (cleanupErrors.length > 0) {
  throw new AggregateError(
    cleanupErrors.map(message => new Error(message)),
    'Smoke cleanup was incomplete.'
  )
}
