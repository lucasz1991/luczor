import { LuczorApi } from '@/services/api/luczorApi'
import { commitProjectSync, enqueueProjectSync, flushProjectSyncQueue } from '@/services/api/projectSyncQueue'
import { executionGate } from '@/services/executionGate'
import { getProjectWorkspace } from '@/services/projectWorkspace'
import { saveAppStateStrict } from '@/services/persistence'
import { mutations, state } from '@/state/store'
import type { ProjectGoal } from '@/state/types'
import { asGoalStatus, asString, getProject, uid } from './shared'
import type { ToolDef } from './types'

export const projectStateTools: ToolDef[] = [
  {
    name: 'project_get_state',
    category: 'project',
    description:
      'Read the current active project state (name, rolling summary, and goals). Use before editing and again after project_set_summary/project_upsert_goal to report the verified result.',
    mutating: false,
    requiresApproval: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      // Keep at least one optional property: the active Nvidia/OpenRouter
      // grammar rejects function schemas whose properties object is empty.
      properties: {
        include_goals: {
          type: 'boolean',
          description: 'Include project goals in the result. Defaults to true.',
        },
      },
      required: [],
    },
    async execute(args, ctx) {
      const project = getProject(ctx.projectId)
      const includeGoals = args.include_goals !== false
      const workspace = await getProjectWorkspace(ctx.projectId).catch(() => null)
      return {
        id: ctx.projectId,
        name: project?.name ?? ctx.projectId,
        summary: project?.summary ?? '',
        goals: includeGoals
          ? (project?.goals ?? []).map(goal => ({
              id: goal.id,
              title: goal.title,
              description: goal.description ?? '',
              status: goal.status,
            }))
          : undefined,
        workspace: workspace
          ? {
              bound: true,
              status: workspace.status,
              display_name: workspace.displayName,
              is_git_repository: workspace.isGitRepository,
              alias: '@project',
            }
          : { bound: false, status: 'unbound', alias: '@project' },
      }
    },
  },
  {
    name: 'project_set_summary',
    category: 'project',
    description:
      "Replace the project's rolling summary with a concise, up-to-date German summary of the project's state and decisions.",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: {
          type: 'string',
          description: 'The new rolling summary (German, concise).',
        },
      },
      required: ['summary'],
    },
    async execute(args, ctx) {
      const summary = asString(args.summary).trim()
      if (!summary) throw new Error('summary is empty')
      mutations.setProjectSummary(ctx.projectId, summary)
      return { ok: true, summary }
    },
  },
  {
    name: 'project_upsert_goal',
    category: 'project',
    description: 'Create or update a project goal. Omit id to create a new goal; provide an existing id to update it.',
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'string',
          description: 'Existing goal id to update. Omit or leave empty to create a new goal.',
        },
        title: { type: 'string', description: 'Short goal title (German).' },
        description: { type: 'string', description: 'Optional longer description.' },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done'],
          description: 'Goal status.',
        },
      },
      required: ['title', 'status'],
    },
    async execute(args, ctx) {
      const title = asString(args.title).trim()
      if (!title) throw new Error('title is empty')

      const existingId = asString(args.id).trim()
      const now = Date.now()
      const project = getProject(ctx.projectId)
      const existing = existingId ? (project?.goals ?? []).find(goal => goal.id === existingId) : undefined

      const goal: ProjectGoal = {
        id: existing?.id ?? (existingId || uid()),
        title,
        description: asString(args.description).trim() || existing?.description,
        status: asGoalStatus(args.status),
        priority: existing?.priority,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        doneAt: asGoalStatus(args.status) === 'done' ? (existing?.doneAt ?? now) : null,
      }

      mutations.upsertGoal(ctx.projectId, goal)
      return { ok: true, goal: { id: goal.id, title: goal.title, status: goal.status } }
    },
  },
]

export const projectCreationTools: ToolDef[] = [
  {
    name: 'project_create',
    category: 'project',
    description:
      'Create a NEW, separate project only when the user explicitly asks for another/new project. Never use this to edit or save goals, summary, or tasks of the current project.',
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', description: 'Project name (German).' } },
      required: ['name'],
    },
    async execute(args, ctx) {
      const name = asString(args.name).trim()
      if (!name) throw new Error('name is empty')
      const execution = ctx.execution ?? executionGate.capture(ctx.signal)
      executionGate.assert(execution, true)
      const apiConfig = await LuczorApi.getConfigSnapshot()
      executionGate.assert(execution, true)
      const externalId = uid()
      // Persist the idempotent server mutation before reporting local success.
      // A failed or aborted POST remains retryable across app restarts.
      const staged = await enqueueProjectSync(externalId, name, apiConfig)
      await commitProjectSync(staged, async () => {
        executionGate.assert(execution, true)
        // Keep the current chat selected until this tool turn has checkpointed
        // its mutation. Switching here would revoke the tool's own execution.
        mutations.addProject({ id: externalId, name }, false)
        try {
          await saveAppStateStrict(state)
        } catch (error) {
          mutations.rollbackProjectCreation(externalId)
          throw error
        }
      })

      // Do not keep the tool mutation open across a network await. The durable
      // queue retries on the status heartbeat and on manual synchronization.
      void flushProjectSyncQueue({ config: apiConfig, signal: ctx.signal }).catch(() => undefined)

      return { ok: true, project_id: externalId, name, synced: false, sync_queued: true }
    },
  },
]
