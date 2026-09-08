import { LuczorApi } from '@/services/api/luczorApi'
import { asString, ensureCurrentProjectOnServer } from './shared'
import type { ToolDef } from './types'

type TaskCreateFailure = {
  ok: false
  code:
    | 'task_create_invalid_title'
    | 'task_create_project_scope_rejected'
    | 'task_create_project_prepare_failed'
    | 'task_create_rejected'
    | 'task_create_outcome_unknown'
  error: string
  retry: 'fix_arguments' | 'retry_same_call' | 'stop' | 'verify_before_retry'
  next_tool?: 'task_list'
  next_arguments?: { project_id: string; external_id?: string }
  match_title?: string
  match_task_id?: string
}

type ConversationCreateFailure = {
  ok: false
  code:
    | 'conversation_create_project_scope_rejected'
    | 'conversation_create_project_prepare_failed'
    | 'conversation_create_rejected'
    | 'conversation_create_outcome_unknown'
  error: string
  retry: 'fix_arguments' | 'retry_same_call' | 'stop' | 'verify_before_retry'
  next_tool?: 'chat_list'
  next_arguments?: { project_id: string; external_id: string }
  match_title?: string
  match_conversation_id?: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined
}

function projectPreparationFailure(error: unknown): TaskCreateFailure {
  return {
    ok: false,
    code: 'task_create_project_prepare_failed',
    error: `task_create wurde vor dem Anlegen der Aufgabe gestoppt: ${errorMessage(error)}. Es wurde noch kein Task-POST gesendet.`,
    retry: 'retry_same_call',
  }
}

function taskCreationFailure(error: unknown, projectId: string, title: string, externalId: string): TaskCreateFailure {
  const status = errorStatus(error)
  const detail = errorMessage(error)
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return {
      ok: false,
      code: 'task_create_rejected',
      error: `task_create wurde vom Server abgelehnt (HTTP ${status}): ${detail}`,
      retry: status === 400 || status === 422 ? 'fix_arguments' : 'stop',
    }
  }
  return {
    ok: false,
    code: 'task_create_outcome_unknown',
    error:
      `Der Ausgang von task_create ist unklar: ${detail}. ` +
      'Wiederhole task_create nicht sofort, da die Aufgabe bereits gespeichert sein kann. Prüfe zuerst task_list für das angegebene Projekt und den Titel.',
    retry: 'verify_before_retry',
    next_tool: 'task_list',
    next_arguments: { project_id: projectId, external_id: externalId },
    match_title: title,
    match_task_id: externalId,
  }
}

function conversationCreationFailure(
  error: unknown,
  projectId: string,
  title: string,
  externalId: string
): ConversationCreateFailure {
  const status = errorStatus(error)
  const detail = errorMessage(error)
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return {
      ok: false,
      code: 'conversation_create_rejected',
      error: `chat_create wurde vom Server abgelehnt (HTTP ${status}): ${detail}`,
      retry: status === 400 || status === 422 ? 'fix_arguments' : 'stop',
    }
  }
  return {
    ok: false,
    code: 'conversation_create_outcome_unknown',
    error:
      `Der Ausgang von chat_create ist unklar: ${detail}. ` +
      'Wiederhole chat_create nicht sofort, da der Chat bereits gespeichert sein kann. Prüfe zuerst chat_list mit der angegebenen external_id.',
    retry: 'verify_before_retry',
    next_tool: 'chat_list',
    next_arguments: { project_id: projectId, external_id: externalId },
    match_title: title,
    match_conversation_id: externalId,
  }
}

export const taskTools: ToolDef[] = [
  {
    name: 'chat_create',
    category: 'app',
    description:
      'Start a new chat/conversation. When project_id is omitted, attach it to the current Luczor project. Returns the conversation id.',
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Optional chat title.' },
        project_id: { type: 'string', description: 'Optional project id to attach the chat to.' },
      },
      required: [],
    },
    async execute(args, ctx) {
      const apiConfig = await LuczorApi.getConfigSnapshot()
      ctx.signal?.throwIfAborted()
      const requestedProjectId = asString(args.project_id).trim()
      if (requestedProjectId && requestedProjectId !== ctx.projectId) {
        return {
          ok: false,
          code: 'conversation_create_project_scope_rejected',
          error: 'chat_create darf nur im aktuell gebundenen Luczor-Projekt schreiben; der POST wurde nicht gesendet.',
          retry: 'fix_arguments',
        } satisfies ConversationCreateFailure
      }
      const projectId = requestedProjectId || ctx.projectId
      try {
        await ensureCurrentProjectOnServer(ctx.projectId, ctx.signal, apiConfig)
      } catch (error) {
        return {
          ok: false,
          code: 'conversation_create_project_prepare_failed',
          error: `chat_create wurde vor dem Anlegen gestoppt: ${errorMessage(error)}. Es wurde noch kein Chat-POST gesendet.`,
          retry: 'retry_same_call',
        } satisfies ConversationCreateFailure
      }
      const suppliedExternalId = asString(args.external_id).trim()
      if (suppliedExternalId && !UUID_PATTERN.test(suppliedExternalId)) {
        return {
          ok: false,
          code: 'conversation_create_rejected',
          error: 'Die interne chat_create-Operations-ID ist ungültig; der Chat-POST wurde nicht gesendet.',
          retry: 'stop',
        } satisfies ConversationCreateFailure
      }
      const externalId = suppliedExternalId || crypto.randomUUID()
      const title = asString(args.title) || 'Neuer Chat'
      try {
        const response = await LuczorApi.createConversation(
          {
            external_id: externalId,
            title: asString(args.title) || undefined,
            project_id: projectId,
          },
          ctx.signal,
          apiConfig
        )
        return { ok: true, conversation_id: response.data.external_id }
      } catch (error) {
        return conversationCreationFailure(error, projectId, title, externalId)
      }
    },
  },
  {
    name: 'chat_list',
    category: 'app',
    description: 'List chats in the current project or verify one exact chat_create operation by external_id.',
    mutating: false,
    requiresApproval: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project_id: { type: 'string', maxLength: 190 },
        external_id: { type: 'string', description: 'Optional exact chat id used to verify an uncertain create.' },
      },
      required: [],
    },
    async execute(args, ctx) {
      const apiConfig = await LuczorApi.getConfigSnapshot()
      ctx.signal?.throwIfAborted()
      const projectId = asString(args.project_id).trim() || ctx.projectId
      if (projectId !== ctx.projectId) throw new Error('chat_list darf nur das aktuell gebundene Luczor-Projekt lesen.')
      const externalId = asString(args.external_id).trim() || undefined
      let response: Awaited<ReturnType<typeof LuczorApi.listConversations>>
      try {
        response = await LuczorApi.listConversations(
          { project_id: projectId, external_id: externalId },
          ctx.signal,
          apiConfig
        )
      } catch (error) {
        if (errorStatus(error) !== 403 || !externalId) throw error
        ctx.signal?.throwIfAborted()
        const verification = await LuczorApi.verifyConversationCreate(externalId, projectId, ctx.signal, apiConfig)
        response = {
          data: verification.data.exists ? [{ external_id: verification.data.external_id }] : [],
          meta: verification.meta,
        }
      }
      return {
        ok: true,
        conversations: response.data,
        conversation_create_idempotency: response.meta?.conversation_create_idempotency,
        filtered_external_id: response.meta?.filters?.external_id,
      }
    },
  },
  {
    name: 'task_create',
    category: 'app',
    description:
      'Create a task in the current Luczor project. project_id may only repeat the current project id. Returns the task id. If the result is uncertain, inspect task_list before retrying.',
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Task title (German).' },
        description: { type: 'string', maxLength: 4000, description: 'Optional details.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        project_id: { type: 'string', maxLength: 190, description: 'Optional project id.' },
        conversation_id: { type: 'string', maxLength: 190, description: 'Optional chat id.' },
        due_at: { type: 'string', description: 'Optional ISO 8601 due date.' },
      },
      required: ['title'],
    },
    async execute(args, ctx) {
      const apiConfig = await LuczorApi.getConfigSnapshot()
      ctx.signal?.throwIfAborted()
      const title = asString(args.title).trim()
      if (!title) {
        return {
          ok: false,
          code: 'task_create_invalid_title',
          error: 'task_create benötigt im Feld title einen nicht leeren Text.',
          retry: 'fix_arguments',
        } satisfies TaskCreateFailure
      }
      const requestedProjectId = asString(args.project_id).trim()
      if (requestedProjectId && requestedProjectId !== ctx.projectId) {
        return {
          ok: false,
          code: 'task_create_project_scope_rejected',
          error:
            'task_create darf nur im aktuell gebundenen Luczor-Projekt schreiben; der Task-POST wurde nicht gesendet.',
          retry: 'fix_arguments',
        } satisfies TaskCreateFailure
      }
      const projectId = requestedProjectId || ctx.projectId
      try {
        await ensureCurrentProjectOnServer(ctx.projectId, ctx.signal, apiConfig)
      } catch (error) {
        return projectPreparationFailure(error)
      }
      const suppliedExternalId = asString(args.external_id).trim()
      if (suppliedExternalId && !UUID_PATTERN.test(suppliedExternalId)) {
        return {
          ok: false,
          code: 'task_create_rejected',
          error: 'Die interne task_create-Operations-ID ist ungültig; der Task-POST wurde nicht gesendet.',
          retry: 'stop',
        } satisfies TaskCreateFailure
      }
      const externalId = suppliedExternalId || crypto.randomUUID()
      try {
        const response = await LuczorApi.createTask(
          {
            external_id: externalId,
            title,
            description: asString(args.description) || undefined,
            priority: asString(args.priority) || undefined,
            project_id: projectId,
            conversation_id: asString(args.conversation_id) || undefined,
            due_at: asString(args.due_at) || undefined,
          },
          ctx.signal,
          apiConfig
        )
        return { ok: true, task_id: response.data.external_id }
      } catch (error) {
        return taskCreationFailure(error, projectId, title, externalId)
      }
    },
  },
  {
    name: 'task_list',
    category: 'app',
    description: 'List tasks, optionally filtered by status/project/chat.',
    mutating: false,
    requiresApproval: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
        project_id: { type: 'string' },
        conversation_id: { type: 'string' },
        external_id: { type: 'string', description: 'Optional exact task id used to verify an uncertain create.' },
      },
      required: [],
    },
    async execute(args, ctx) {
      const apiConfig = await LuczorApi.getConfigSnapshot()
      ctx.signal?.throwIfAborted()
      const status = asString(args.status) || undefined
      const projectId = asString(args.project_id) || ctx.projectId
      const conversationId = asString(args.conversation_id) || undefined
      const externalId = asString(args.external_id) || undefined
      let response: Awaited<ReturnType<typeof LuczorApi.listTasks>>
      try {
        response = await LuczorApi.listTasks(
          {
            status,
            project_id: projectId,
            conversation_id: conversationId,
            external_id: externalId,
          },
          ctx.signal,
          apiConfig
        )
      } catch (error) {
        if (errorStatus(error) !== 403 || !externalId || status || conversationId) throw error
        ctx.signal?.throwIfAborted()
        const verification = await LuczorApi.verifyTaskCreate(externalId, projectId, ctx.signal, apiConfig)
        response = {
          data: verification.data.exists ? [{ external_id: verification.data.external_id }] : [],
          meta: verification.meta,
        }
      }
      return {
        ok: true,
        tasks: response.data,
        task_create_idempotency: response.meta?.task_create_idempotency,
        filtered_external_id: response.meta?.filters?.external_id,
      }
    },
  },
  {
    name: 'task_update',
    category: 'app',
    description: 'Update a task: change status (e.g. in_progress), priority, assignment, title or description.',
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'The task id to update.' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        title: { type: 'string' },
        description: { type: 'string' },
        project_id: { type: 'string', description: 'Assign/move to this project.' },
        conversation_id: { type: 'string', description: 'Assign/move to this chat.' },
      },
      required: ['task_id'],
    },
    async execute(args, ctx) {
      const apiConfig = await LuczorApi.getConfigSnapshot()
      ctx.signal?.throwIfAborted()
      const taskId = asString(args.task_id).trim()
      if (!taskId) throw new Error('task_id is empty')
      const body: Record<string, unknown> = {}
      const status = asString(args.status)
      const priority = asString(args.priority)
      const title = asString(args.title)
      const description = asString(args.description)
      const projectId = asString(args.project_id)
      const conversationId = asString(args.conversation_id)
      if (status) body.status = status
      if (priority) body.priority = priority
      if (title) body.title = title
      if (description) body.description = description
      if (projectId) body.project_id = projectId
      if (conversationId) body.conversation_id = conversationId
      await LuczorApi.updateTask(taskId, body, ctx.signal, apiConfig)
      return { ok: true, task_id: taskId }
    },
  },
  {
    name: 'task_complete',
    category: 'app',
    description: 'Mark a task as done.',
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { task_id: { type: 'string', description: 'The task id to complete.' } },
      required: ['task_id'],
    },
    async execute(args, ctx) {
      const apiConfig = await LuczorApi.getConfigSnapshot()
      ctx.signal?.throwIfAborted()
      const taskId = asString(args.task_id).trim()
      if (!taskId) throw new Error('task_id is empty')
      await LuczorApi.updateTask(taskId, { status: 'done' }, ctx.signal, apiConfig)
      return { ok: true, task_id: taskId, status: 'done' }
    },
  },
]
