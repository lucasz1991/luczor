import { assertPlanPrincipal, currentPlanStep, getPlan, planProgress, setPlan } from '@/services/plan'
import { executionGate } from '@/services/executionGate'
import { resolveWorkspacePrincipalId } from '@/services/projectWorkspace'
import type { ToolContext, ToolDef } from './types'

async function planPrincipal(ctx: ToolContext) {
  const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
  executionGate.assert(ticket)
  const principalId = await resolveWorkspacePrincipalId()
  executionGate.assert(ticket)
  assertPlanPrincipal(principalId)
  return { principalId, ticket }
}

export const planTools: ToolDef[] = [
  {
    name: 'plan_update',
    category: 'app',
    description:
      'Create or update the visible step plan for the current task. Use it BEFORE starting work that needs 3+ steps, then update it after finishing each step. Exactly one step may be in_progress. Display only - it changes no files, no system state and no project data.',
    // Display-only: gating this behind an approval dialog would interrupt the
    // user on every status tick without protecting anything.
    mutating: false,
    requiresApproval: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        steps: {
          type: 'array',
          description: 'The full plan, always sent complete (not a delta). Max 24 steps.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: 'Short imperative step title (German).' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'done', 'skipped'],
                description: 'Step status. At most ONE step may be in_progress.',
              },
            },
            required: ['title', 'status'],
          },
        },
        note: { type: 'string', description: 'Optional one-line note about the current state.' },
      },
      required: ['steps'],
    },
    async execute(args, ctx) {
      const { principalId, ticket } = await planPrincipal(ctx)
      executionGate.assert(ticket)
      assertPlanPrincipal(principalId)
      const { plan, repairs } = setPlan(ctx.projectId, args.steps, args.note, principalId)
      const progress = planProgress(plan)
      return {
        ok: true,
        steps: plan.steps,
        progress: `${progress.done}/${progress.total}`,
        current_step: currentPlanStep(plan)?.title ?? null,
        // Surfacing repairs lets the model correct itself next round.
        corrections: repairs,
      }
    },
  },
  {
    name: 'plan_get',
    category: 'app',
    description: 'Read the current step plan for this project, including which step is in progress.',
    mutating: false,
    requiresApproval: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_done: { type: 'boolean', description: 'Include finished steps. Defaults to true.' },
      },
      required: [],
    },
    async execute(args, ctx) {
      const { principalId, ticket } = await planPrincipal(ctx)
      executionGate.assert(ticket)
      assertPlanPrincipal(principalId)
      const plan = getPlan(ctx.projectId, principalId)
      const progress = planProgress(plan)
      const steps =
        args.include_done === false
          ? plan.steps.filter(step => step.status !== 'done' && step.status !== 'skipped')
          : plan.steps
      return {
        ok: true,
        steps,
        note: plan.note,
        progress: `${progress.done}/${progress.total}`,
        current_step: currentPlanStep(plan)?.title ?? null,
      }
    },
  },
]
