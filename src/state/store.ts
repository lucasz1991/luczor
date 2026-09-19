// src/state/store.ts
import { reactive } from 'vue'
import { DEFAULT_STATE } from '@/state/defaults'
import type * as AppTypes from '@/state/types'
import { migrateConversations } from '@/services/chatConversations'
import {
  createSafeRecord,
  deleteSafeRecordValue,
  getSafeRecordValue,
  isSafeRecordKey,
  setSafeRecordValue,
} from '@/services/safeRecord'

/* =========================================================
 * Utils
 * ========================================================= */
const clone = <Value>(value: Value): Value => {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as Value
  }
}

const uid = () => crypto.randomUUID?.() ?? `m_${Math.random().toString(16).slice(2)}_${Date.now()}`

const now = () => Date.now()

/* =========================================================
 * State
 * ========================================================= */
export const state = reactive<AppTypes.AppState>(clone(DEFAULT_STATE))

function ensureGlobalUi() {
  state.global.ui ??= {}
}

function getActiveProjectId(): AppTypes.Id {
  ensureGlobalUi()
  return state.global.ui!.lastProjectId ?? state.projects[0]?.id ?? 'default'
}

function ensureProjectExists(projectId: AppTypes.Id) {
  if (state.projects.some(project => project.id === projectId)) return

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

function ensurePendingBucket(projectId: AppTypes.Id): AppTypes.PendingToolCall[] {
  state.pending.toolCallsByProject ??= {}
  if (!isSafeRecordKey(projectId)) throw new Error('Unsafe project id rejected.')
  const existing = getSafeRecordValue(state.pending.toolCallsByProject, projectId)
  if (existing) return existing

  const bucket: AppTypes.PendingToolCall[] = []
  setSafeRecordValue(state.pending.toolCallsByProject, projectId, bucket)
  return bucket
}

/* =========================================================
 * Message factories
 * ========================================================= */
function makeMsg(
  role: AppTypes.ChatRole,
  content: string,
  projectId?: AppTypes.Id,
  conversationId?: AppTypes.Id
): AppTypes.Message {
  const timestamp = now()
  return {
    id: uid(),
    projectId: projectId ?? getActiveProjectId(),
    conversationId: conversationId ?? mutations.getActiveConversationId(projectId ?? getActiveProjectId()),
    role,
    content,
    ts: timestamp,
    createdAt: timestamp,
    raw: undefined,
    parsed: null,
    visibility: 'visible',
    meta: {},
  }
}

function makeHiddenToolMsg(
  projectId: AppTypes.Id,
  payload: { content?: string; parsed?: unknown; meta?: AppTypes.MessageMeta }
): AppTypes.Message {
  const timestamp = now()
  return {
    id: uid(),
    projectId,
    role: 'tool',
    content: payload.content ?? '',
    ts: timestamp,
    createdAt: timestamp,
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

  hydrate(next: AppTypes.AppState) {
    const fresh = clone(next)

    state.version = 1

    state.global = fresh.global
    state.projects = Array.isArray(fresh.projects)
      ? fresh.projects.filter(project => typeof project?.id === 'string' && isSafeRecordKey(project.id))
      : clone(DEFAULT_STATE.projects)
    state.messages = fresh.messages
    state.conversations = fresh.conversations ?? []
    state.conversationSchemaVersion = fresh.conversationSchemaVersion

    state.todos = fresh.todos ?? []
    state.todoSteps = fresh.todoSteps ?? []
    state.projectMemories = fresh.projectMemories ?? []

    state.summaries = fresh.summaries ?? []

    const safeBuckets = createSafeRecord<AppTypes.PendingToolCall[]>()
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
    for (const project of state.projects) ensurePendingBucket(project.id)
    migrateConversations(state)
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
    migrateConversations(state)

    const hasAnyVisible = state.messages.some(message => message.projectId === pid && message.visibility !== 'hidden')

    if (!hasAnyVisible) {
      state.messages.push(makeMsg('assistant', 'Willkommen. Was ist das Ziel dieses Projekts?', pid))
    }
  },

  /* -----------------------------
   * Project selection & creation
   * ----------------------------- */
  setActiveProject(projectId: AppTypes.Id) {
    ensureGlobalUi()
    ensureProjectExists(projectId)
    ensurePendingBucket(projectId)

    state.global.ui!.lastProjectId = projectId
    this.touchProject(projectId)
  },

  addProject(project: { id: AppTypes.Id; name: string }, activate = true) {
    if (!state.projects.some(existing => existing.id === project.id)) {
      state.projects.unshift({
        id: project.id,
        name: project.name,
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

    ensurePendingBucket(project.id)
    if (activate) this.setActiveProject(project.id)

    const hasAnyVisible = state.messages.some(
      message => message.projectId === project.id && message.visibility !== 'hidden'
    )

    if (!hasAnyVisible) {
      state.messages.push(makeMsg('assistant', 'Willkommen. Was ist das Ziel dieses Projekts?', project.id))
    }
  },

  renameProject(projectId: AppTypes.Id, name: string) {
    if (!isSafeRecordKey(projectId)) throw new Error('Unsafe project id rejected.')
    const trimmed = name.trim().slice(0, 160)
    if (!trimmed) return
    const prj = state.projects.find(project => project.id === projectId)
    if (!prj || prj.name === trimmed) return
    prj.name = trimmed
    prj.updatedAt = now()
  },

  /** Roll back a newly added, not-yet-activated project after strict persistence failed. */
  rollbackProjectCreation(projectId: AppTypes.Id) {
    if (state.global.ui?.lastProjectId === projectId)
      throw new Error('Das aktive Projekt kann nicht als unbestätigt verworfen werden.')
    state.projects = state.projects.filter(project => project.id !== projectId)
    state.messages = state.messages.filter(message => message.projectId !== projectId)
    state.todos = state.todos.filter(item => item?.projectId !== projectId)
    state.todoSteps = state.todoSteps.filter(item => item?.projectId !== projectId)
    state.projectMemories = state.projectMemories.filter(item => item?.projectId !== projectId)
    state.summaries = state.summaries.filter(summary => summary.projectId !== projectId)
    deleteSafeRecordValue(state.pending.toolCallsByProject, projectId)
  },

  touchProject(projectId: AppTypes.Id) {
    const prj = state.projects.find(project => project.id === projectId)
    if (prj) prj.updatedAt = now()
  },

  /* -----------------------------
   * Project data (summary/goals)
   * ----------------------------- */
  setProjectSummary(projectId: AppTypes.Id, summary: string) {
    ensureProjectExists(projectId)
    const prj = state.projects.find(project => project.id === projectId)!
    prj.summary = summary
    prj.updatedAt = now()
  },

  upsertGoal(projectId: AppTypes.Id, goal: AppTypes.ProjectGoal) {
    ensureProjectExists(projectId)
    const prj = state.projects.find(project => project.id === projectId)!

    const idx = prj.goals.findIndex(existingGoal => existingGoal.id === goal.id)
    if (idx === -1) prj.goals.push(goal)
    else prj.goals[idx] = goal

    prj.updatedAt = now()
  },

  /* -----------------------------
   * Messages
   * ----------------------------- */
  getProjectMessages(projectId: AppTypes.Id, opts?: { includeHidden?: boolean }): AppTypes.Message[] {
    ensureProjectExists(projectId)
    const includeHidden = opts?.includeHidden ?? false

    return state.messages
      .filter(message => message.projectId === projectId)
      .filter(message => includeHidden || message.visibility !== 'hidden')
      .sort((left, right) => left.ts - right.ts)
  },

  getActiveConversationId(projectId: AppTypes.Id): AppTypes.Id {
    ensureProjectExists(projectId)
    migrateConversations(state)
    return getSafeRecordValue(state.global.ui!.lastConversationByProject!, projectId) ?? ''
  },

  setActiveConversation(projectId: AppTypes.Id, conversationId: AppTypes.Id) {
    const chat = state.conversations?.find(
      item => item.id === conversationId && item.projectId === projectId && !item.archivedAt
    )
    if (!chat) throw new Error('Chat nicht verfügbar.')
    this.setActiveProject(projectId)
    state.global.ui!.lastConversationByProject ??= {}
    setSafeRecordValue(state.global.ui!.lastConversationByProject, projectId, conversationId)
  },

  createConversation(
    projectId: AppTypes.Id,
    title = 'Neuer Chat',
    settings?: AppTypes.ConversationSettings
  ): AppTypes.Conversation {
    this.getActiveConversationId(projectId)
    const timestamp = now()
    const chat: AppTypes.Conversation = {
      id: uid(),
      projectId,
      title: title.trim().slice(0, 160) || 'Neuer Chat',
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      ...(settings && Object.keys(settings).length ? { settings: { ...settings } } : {}),
    }
    state.conversations!.push(chat)
    this.setActiveConversation(projectId, chat.id)
    return chat
  },

  getConversation(conversationId: AppTypes.Id): AppTypes.Conversation | undefined {
    return state.conversations?.find(item => item.id === conversationId)
  },

  /** Per-chat controls are merged; `undefined` removes a key so the device default applies again. */
  updateConversationSettings(conversationId: AppTypes.Id, patch: AppTypes.ConversationSettings): boolean {
    const chat = this.getConversation(conversationId)
    if (!chat) return false
    const next: AppTypes.ConversationSettings = { ...(chat.settings ?? {}) }
    let changed = false
    for (const key of ['mode', 'routeMode', 'thinkingTier'] as const) {
      if (!(key in patch)) continue
      // eslint-disable-next-line security/detect-object-injection
      const value = patch[key]
      // eslint-disable-next-line security/detect-object-injection
      if (next[key] === value) continue
      changed = true
      // eslint-disable-next-line security/detect-object-injection
      if (value === undefined) delete next[key]
      // eslint-disable-next-line security/detect-object-injection
      else (next as Record<string, unknown>)[key] = value
    }
    if (!changed) return false
    chat.settings = next
    return true
  },

  renameConversation(projectId: AppTypes.Id, conversationId: AppTypes.Id, title: string) {
    const chat = state.conversations?.find(item => item.id === conversationId && item.projectId === projectId)
    if (!chat || !title.trim()) return
    chat.title = title.trim().slice(0, 160)
    chat.updatedAt = now()
  },

  /** Soft-delete: archived chats drop out of every list/selection filter but their messages stay
   * for potential recovery, matching how projects are archived elsewhere in this store. */
  deleteConversation(projectId: AppTypes.Id, conversationId: AppTypes.Id) {
    const chat = state.conversations?.find(
      item => item.id === conversationId && item.projectId === projectId && !item.archivedAt
    )
    if (!chat) return
    state.global.ui!.lastConversationByProject ??= {}
    const wasActive = getSafeRecordValue(state.global.ui!.lastConversationByProject!, projectId) === conversationId
    // Line up the replacement selection BEFORE archiving: getActiveConversationId() runs
    // migrateConversations() as a read-time side effect, and some computed reactively re-reads it
    // the instant `archivedAt` changes below. If that happened while this was still "the selected
    // chat" with nothing else to fall back on, migrateConversations' own "always keep one active
    // chat" safety net would silently un-archive it again before this function even returns.
    if (wasActive) {
      const fallback = state.conversations?.find(
        item => item.projectId === projectId && !item.archivedAt && item.id !== conversationId
      )
      if (fallback) setSafeRecordValue(state.global.ui!.lastConversationByProject!, projectId, fallback.id)
      else this.createConversation(projectId)
    }
    chat.archivedAt = now()
    chat.updatedAt = now()
  },

  getConversationMessages(
    projectId: AppTypes.Id,
    conversationId: AppTypes.Id,
    opts?: { includeHidden?: boolean }
  ): AppTypes.Message[] {
    return this.getProjectMessages(projectId, opts).filter(
      message => message.conversationId === conversationId || message.meta.conversationId === conversationId
    )
  },

  addMessage(msg: AppTypes.Message) {
    ensureProjectExists(msg.projectId)
    msg.conversationId ??= msg.meta.conversationId ?? this.getActiveConversationId(msg.projectId)
    state.messages.push(msg)
    this.touchProject(msg.projectId)
  },

  addHiddenToolMessage(projectId: AppTypes.Id, parsed: unknown, meta?: AppTypes.MessageMeta) {
    ensureProjectExists(projectId)
    const message = makeHiddenToolMsg(projectId, { parsed, meta })
    message.conversationId = meta?.conversationId ?? this.getActiveConversationId(projectId)
    state.messages.push(message)
    this.touchProject(projectId)
  },

  patchMessage(projectId: AppTypes.Id, messageId: AppTypes.Id, patch: Partial<AppTypes.Message>) {
    const idx = state.messages.findIndex(message => message.projectId === projectId && message.id === messageId)
    if (idx === -1) return

    const current = state.messages[idx]!

    const next: AppTypes.Message = {
      ...current,
      ...patch,
      id: current.id,
      projectId: current.projectId,
      conversationId: current.conversationId,
      role: (patch.role ?? current.role) as AppTypes.ChatRole,
      content: patch.content ?? current.content,
      ts: patch.ts ?? current.ts,
      createdAt: patch.createdAt ?? current.createdAt,
      visibility: patch.visibility ?? current.visibility,
      meta: { ...(current.meta ?? {}), ...(patch.meta ?? {}) },
    }

    state.messages[idx] = next
    this.touchProject(projectId)
  },

  resetProjectChat(projectId: AppTypes.Id) {
    ensureProjectExists(projectId)

    // Keep hidden backchannel tool messages so AI can retain overview
    const hidden = state.messages.filter(message => message.projectId === projectId && message.visibility === 'hidden')

    state.messages = state.messages.filter(message => message.projectId !== projectId)
    state.messages.push(...hidden)

    state.messages.push(makeMsg('assistant', 'Neuer Chat. Was ist das Ziel?', projectId))
    this.touchProject(projectId)
  },

  /* -----------------------------
   * Pending tool calls (approval/execution)
   * ----------------------------- */
  queueToolCall(projectId: AppTypes.Id, call: Omit<AppTypes.PendingToolCall, 'projectId' | 'createdAt' | 'updatedAt'>) {
    ensureProjectExists(projectId)
    const bucket = ensurePendingBucket(projectId)

    const full: AppTypes.PendingToolCall = {
      ...call,
      projectId,
      createdAt: now(),
      updatedAt: now(),
    }

    bucket.push(full)
    this.touchProject(projectId)
    return full
  },

  updateToolCallStatus(projectId: AppTypes.Id, toolCallId: AppTypes.Id, status: AppTypes.ToolCallStatus) {
    const bucket = ensurePendingBucket(projectId)
    const pending = bucket.find(item => item.id === toolCallId)
    if (!pending) return

    pending.status = status
    pending.updatedAt = now()
    this.touchProject(projectId)
  },

  setToolResult(projectId: AppTypes.Id, result: AppTypes.ToolResult) {
    const bucket = ensurePendingBucket(projectId)
    const pending = bucket.find(item => item.id === result.toolCallId)
    if (!pending) return

    pending.result = result
    pending.status = result.ok ? 'executed' : 'failed'
    pending.updatedAt = now()

    // store backchannel result as hidden message (not shown in UI)
    this.addHiddenToolMessage(projectId, result, {
      toolCallId: result.toolCallId,
      toolName: result.name,
    })

    this.touchProject(projectId)
  },
}
