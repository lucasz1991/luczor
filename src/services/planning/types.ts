import type { AgentTeamRun } from '@/services/agents/teams'
import type { AgentPermission, AgentProjectSnapshot } from '@/services/agents/types'

export const PLANNING_EXPORT_VERSION = 1 as const
export const MAX_PLANNING_STEPS = 12

export type PlanningAdapterId = 'codex' | 'local' | 'policy'

export type PlanningAnalysis = Readonly<{
  summary: string
  findings: readonly string[]
  evidence: readonly string[]
  assumptions: readonly string[]
  risks: readonly string[]
  openQuestions: readonly string[]
}>

export type PlanningStep = Readonly<{
  id: string
  title: string
  description: string
  dependencies: readonly string[]
  acceptanceCriteria: readonly string[]
  verification: readonly string[]
}>

export type PlanningPlan = Readonly<{
  objective: string
  analysis: PlanningAnalysis
  steps: readonly PlanningStep[]
  completionCriteria: readonly string[]
  outOfScope: readonly string[]
}>

export type PlanningSessionStatus =
  'idle' | 'analyzing' | 'planning' | 'review' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type PlanningSession = Readonly<{
  id: string
  revision: number
  project: AgentProjectSnapshot
  objective: string
  status: PlanningSessionStatus
  analysis: PlanningAnalysis | null
  plan: PlanningPlan | null
  execution: AgentTeamRun | null
  error: string
  output: string
}>

export type PlanningAnalyzeInput = Readonly<{
  objective: string
  adapterId: PlanningAdapterId
  model?: string
  clarifications?: string
}>

export type PlanningExecuteInput = Readonly<{
  expectedSessionId: string
  expectedRevision: number
  adapterId: PlanningAdapterId
  model?: string
  permission: AgentPermission
}>

export type PlanningExport = Readonly<{
  version: typeof PLANNING_EXPORT_VERSION
  exportedAt: string
  session: PlanningSession
}>

export interface PlanningHub {
  get(projectId: string): PlanningSession | null
  subscribe(listener: () => void): () => void
  analyze(projectId: string, input: PlanningAnalyzeInput): Promise<void>
  revise(projectId: string, plan: PlanningPlan): void
  execute(projectId: string, input: PlanningExecuteInput): Promise<void>
  cancel(projectId: string): void
  export(projectId: string): string
  restore(projectId: string, json: string): Promise<void>
}
