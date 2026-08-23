// src/state/store.ts
import { reactive } from 'vue'
import { DEFAULT_STATE } from '@/state/defaults'
import type * as T from '@/state/types'
import { createSafeRecord, getSafeRecordValue, isSafeRecordKey, setSafeRecordValue } from '@/services/safeRecord'

/* =========================================================
 * Utils
 * ========================================================= */
const clone = <X>(x: X): X => {
  try {
    return structuredClone(x)
  } catch {
    return JSON.parse(JSON.stringify(x)) as X
  }
}

const uid = () => crypto.randomUUID?.() ?? `m_${Math.random().toString(16).slice(2)}_${Date.now()}`

const now = () => Date.now()

/* =========================================================
 * State
 * ========================================================= */
export const state = reactive<T.AppState>(clone(DEFAULT_STATE))

function ensureGlobalUi() {
  state.global.ui ??= {}
}

function getActiveProjectId(): T.Id {
  ensureGlobalUi()
  return state.global.ui!.lastProjectId ?? state.projects[0]?.id ?? 'default'
}

function ensureProjectExists(projectId: T.Id) {
  if (state.projects.some(p => p.id === projectId)) return

  state.projects.unshift({
    id: projectId,
    name: projectId === 'default' ? 'Default Project' : projectId,
    goal: undefined,
    goals: [],
    summary: '',
    defaults: { maxOutputTokens: state.global.defaults.maxOutputTokens },
    focus: { activeTodoId: null, activeStepId: null },
    archivedAt: null,
    createdAt: now(),
    updatedAt: now(),
  })
}

function ensurePendingBucket(projectId: T.Id): T.PendingToolCall[] {
  state.pending.toolCallsByProject ??= {}
  if (!isSafeRecordKey(projectId)) throw new Error('Unsafe project id rejected.')
  const existing = getSafeRecordValue(state.pending.toolCallsByProject, projectId)
  if (existing) return existing

  const bucket: T.PendingToolCall[] = []
  setSafeRecordValue(state.pending.toolCallsByProject, projectId, bucket)
  return bucket
}

/* =========================================================
 * Message factories
 * ========================================================= */
function makeMsg(role: T.ChatRole, content: string, projectId?: T.Id): T.Message {
  const t = now()
  return {
    id: uid(),
    projectId: projectId ?? getActiveProjectId(),
    role,
    content,
    ts: t,
    createdAt: t,
    raw: undefined,
    parsed: null,
    visibility: 'visible',
    meta: {},
  }
}

function makeHiddenToolMsg(
  projectId: T.Id,
  payload: { content?: string; parsed?: unknown; meta?: T.MessageMeta }
): T.Message {
  const t = now()
  return {
    id: uid(),
    projectId,
    role: 'tool',
    content: payload.content ?? '',
    ts: t,
    createdAt: t,
    visibility: 'hidden',
    raw: undefined,
    parsed: payload.parsed ?? null,
    meta: payload.meta ?? {},
  }
}

/* =========================================================
 * Mutations
 * ========================================================= */
export const mutations = {
  makeMsg,

  hydrate(next: T.AppState) {
    const fresh = clone(next)

    state.version = 1

    state.global = fresh.global
    state.projects = Array.isArray(fresh.projects)
      ? fresh.projects.filter(project => typeof project?.id === 'string' && isSafeRecordKey(project.id))
      : clone(DEFAULT_STATE.projects)
    state.messages = fresh.messages

    state.todos = fresh.todos ?? []
    state.todoSteps = fresh.todoSteps ?? []
    state.projectMemories = fresh.projectMemories ?? []

    state.summaries = fresh.summaries ?? []

    const safeBuckets = createSafeRecord<T.PendingToolCall[]>()
    const storedBuckets = fresh.pending?.toolCallsByProject
    if (storedBuckets && typeof storedBuckets === 'object') {
      for (const [projectId, bucket] of Object.entries(storedBuckets)) {
        if (isSafeRecordKey(projectId) && Array.isArray(bucket)) {
          setSafeRecordValue(safeBuckets, projectId, bucket)
        }
      }
    }
    state.pending = { toolCallsByProject: safeBuckets }

    // Ensure buckets exist for known projects
    for (const p of state.projects) ensurePendingBucket(p.id)
  },

  ensureDefaults() {
    if (!state.projects?.length) state.projects = clone(DEFAULT_STATE.projects)

    ensureGlobalUi()
    if (!state.global.ui!.lastProjectId) {
      state.global.ui!.lastProjectId = state.projects[0]?.id ?? 'default'
    }

    const pid = state.global.ui!.lastProjectId!
    ensureProjectExists(pid)
    ensurePendingBucket(pid)

    const hasAnyVisible = state.messages.some(m => m.projectId === pid && m.visibility !== 'hidden')

    if (!hasAnyVisible) {
      state.messages.push(makeMsg('assistant', 'Willkommen. Was ist das Ziel dieses Projekts?', pid))
    }
  },

  /* -----------------------------
   * Project selection & creation
   * ----------------------------- */
  setActiveProject(projectId: T.Id) {
    ensureGlobalUi()
    ensureProjectExists(projectId)
    ensurePendingBucket(projectId)

    state.global.ui!.lastProjectId = projectId
    this.touchProject(projectId)
  },

  addProject(p: { id: T.Id; name: string }) {
    if (!state.projects.some(x => x.id === p.id)) {
      state.projects.unshift({
        id: p.id,
        name: p.name,
        goal: undefined,
        goals: [],
        summary: '',
        defaults: { maxOutputTokens: state.global.defaults.maxOutputTokens },
        focus: { activeTodoId: null, activeStepId: null },
        archivedAt: null,
        createdAt: now(),
        updatedAt: now(),
      })
    }

    ensurePendingBucket(p.id)
    this.setActiveProject(p.id)

    const hasAnyVisible = state.messages.some(m => m.projectId === p.id && m.visibility !== 'hidden')

    if (!hasAnyVisible) {
      state.messages.push(makeMsg('assistant', 'Willkommen. Was ist das Ziel dieses Projekts?', p.id))
    }
  },

  touchProject(projectId: T.Id) {
    const prj = state.projects.find(p => p.id === projectId)
    if (prj) prj.updatedAt = now()
  },

  /* -----------------------------
   * Project data (summary/goals)
   * ----------------------------- */
  setProjectSummary(projectId: T.Id, summary: string) {
    ensureProjectExists(projectId)
    const prj = state.projects.find(p => p.id === projectId)!
    prj.summary = summary
    prj.updatedAt = now()
  },

  upsertGoal(projectId: T.Id, goal: T.ProjectGoal) {
    ensureProjectExists(projectId)
    const prj = state.projects.find(p => p.id === projectId)!

    const idx = prj.goals.findIndex(g => g.id === goal.id)
    if (idx === -1) prj.goals.push(goal)
    else prj.goals[idx] = goal

    prj.updatedAt = now()
  },

  /* -----------------------------
   * Messages
   * ----------------------------- */
  getProjectMessages(projectId: T.Id, opts?: { includeHidden?: boolean }): T.Message[] {
    ensureProjectExists(projectId)
    const includeHidden = opts?.includeHidden ?? false

    return state.messages
      .filter(m => m.projectId === projectId)
      .filter(m => includeHidden || m.visibility !== 'hidden')
      .sort((a, b) => a.ts - b.ts)
  },

  addMessage(msg: T.Message) {
    ensureProjectExists(msg.projectId)
    state.messages.push(msg)
    this.touchProject(msg.projectId)
  },

  addHiddenToolMessage(projectId: T.Id, parsed: unknown, meta?: T.MessageMeta) {
    ensureProjectExists(projectId)
    state.messages.push(makeHiddenToolMsg(projectId, { parsed, meta }))
    this.touchProject(projectId)
  },

  patchMessage(projectId: T.Id, messageId: T.Id, patch: Partial<T.Message>) {
    const idx = state.messages.findIndex(m => m.projectId === projectId && m.id === messageId)
    if (idx === -1) return

    const current = state.messages[idx]!

    const next: T.Message = {
      ...current,
      ...patch,
      id: current.id,
      projectId: current.projectId,
      role: (patch.role ?? current.role) as T.ChatRole,
      content: patch.content ?? current.content,
      ts: patch.ts ?? current.ts,
      createdAt: patch.createdAt ?? current.createdAt,
      visibility: patch.visibility ?? current.visibility,
      meta: { ...(current.meta ?? {}), ...(patch.meta ?? {}) },
    }

    state.messages[idx] = next
    this.touchProject(projectId)
  },

  resetProjectChat(projectId: T.Id) {
    ensureProjectExists(projectId)

    // Keep hidden backchannel tool messages so AI can retain overview
    const hidden = state.messages.filter(m => m.projectId === projectId && m.visibility === 'hidden')

    state.messages = state.messages.filter(m => m.projectId !== projectId)
    state.messages.push(...hidden)

    state.messages.push(makeMsg('assistant', 'Neuer Chat. Was ist das Ziel?', projectId))
    this.touchProject(projectId)
  },

  /* -----------------------------
   * Pending tool calls (approval/execution)
   * ----------------------------- */
  queueToolCall(projectId: T.Id, call: Omit<T.PendingToolCall, 'projectId' | 'createdAt' | 'updatedAt'>) {
    ensureProjectExists(projectId)
    const bucket = ensurePendingBucket(projectId)

    const full: T.PendingToolCall = {
      ...call,
      projectId,
      createdAt: now(),
      updatedAt: now(),
    }

    bucket.push(full)
    this.touchProject(projectId)
    return full
  },

  updateToolCallStatus(projectId: T.Id, toolCallId: T.Id, status: T.ToolCallStatus) {
    const bucket = ensurePendingBucket(projectId)
    const item = bucket.find(x => x.id === toolCallId)
    if (!item) return

    item.status = status
    item.updatedAt = now()
    this.touchProject(projectId)
  },

  setToolResult(projectId: T.Id, result: T.ToolResult) {
    const bucket = ensurePendingBucket(projectId)
    const item = bucket.find(x => x.id === result.toolCallId)
    if (!item) return

    item.result = result
    item.status = result.ok ? 'executed' : 'failed'
    item.updatedAt = now()

    // store backchannel result as hidden message (not shown in UI)
    this.addHiddenToolMessage(projectId, result, {
      toolCallId: result.toolCallId,
      toolName: result.name,
    })

    this.touchProject(projectId)
  },
}
