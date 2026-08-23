import { LuczorApi } from '@/services/api/luczorApi'
import { asString, ensureCurrentProjectOnServer } from './shared'
import type { ToolDef } from './types'

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
      const requestedProjectId = asString(args.project_id).trim()
      const projectId = requestedProjectId || ctx.projectId
      if (!requestedProjectId || requestedProjectId === ctx.projectId) {
        await ensureCurrentProjectOnServer(ctx.projectId)
      }
      const response = await LuczorApi.createConversation({
        title: asString(args.title) || undefined,
        project_id: projectId,
      })
      return { ok: true, conversation_id: response.data.external_id }
    },
  },
  {
    name: 'task_create',
    category: 'app',
    description:
      'Create a task. When project_id is omitted, assign it to the current Luczor project. Returns the task id.',
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Task title (German).' },
        description: { type: 'string', description: 'Optional details.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'] },
        project_id: { type: 'string', description: 'Optional project id.' },
        conversation_id: { type: 'string', description: 'Optional chat id.' },
        due_at: { type: 'string', description: 'Optional ISO 8601 due date.' },
      },
      required: ['title'],
    },
    async execute(args, ctx) {
      const title = asString(args.title).trim()
      if (!title) throw new Error('title is empty')
      const requestedProjectId = asString(args.project_id).trim()
      const projectId = requestedProjectId || ctx.projectId
      if (!requestedProjectId || requestedProjectId === ctx.projectId) {
        await ensureCurrentProjectOnServer(ctx.projectId)
      }
      const response = await LuczorApi.createTask({
        title,
        description: asString(args.description) || undefined,
        priority: asString(args.priority) || undefined,
        project_id: projectId,
        conversation_id: asString(args.conversation_id) || undefined,
        due_at: asString(args.due_at) || undefined,
      })
      return { ok: true, task_id: response.data.external_id }
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
      },
      required: [],
    },
    async execute(args) {
      const response = await LuczorApi.listTasks({
        status: asString(args.status) || undefined,
        project_id: asString(args.project_id) || undefined,
        conversation_id: asString(args.conversation_id) || undefined,
      })
      return { ok: true, tasks: response.data }
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
    async execute(args) {
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
      await LuczorApi.updateTask(taskId, body)
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
    async execute(args) {
      const taskId = asString(args.task_id).trim()
      if (!taskId) throw new Error('task_id is empty')
      await LuczorApi.updateTask(taskId, { status: 'done' })
      return { ok: true, task_id: taskId, status: 'done' }
    },
  },
]
