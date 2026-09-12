import { luczorMemory, type MemoryRecord } from '@/services/memory/luczorMemory'
import type { ProjectWorkspaceBinding } from '@/services/projectWorkspace'
import type { Project } from '@/state/types'
import { canAccessCloudProject } from '@/services/cloudProjectAccess'
import {
  assemblePromptContext,
  type AssemblePromptContextOptions,
  type PromptContextAssembly,
  type PromptFragment,
} from './promptContextAssembler'

export type ProjectStartContextOptions = {
  project: Project
  workspace?: ProjectWorkspaceBinding | null
  includeMemory?: boolean
  memoryLimit?: number
  assembly?: AssemblePromptContextOptions
}

export type ProjectStartContextDependencies = {
  recall: typeof luczorMemory.recall
}

const defaultDependencies: ProjectStartContextDependencies = {
  recall: query => luczorMemory.recallLocal(query),
}

function staleness(record: MemoryRecord): string {
  const ageDays = Math.max(0, (Date.now() - record.updatedAt) / 86_400_000)
  if (ageDays <= 30) return 'current'
  if (ageDays <= 180) return 'aging'
  return 'stale'
}

function memoryFragment(record: MemoryRecord, index: number): PromptFragment {
  return {
    id: `memory-${record.scope}-${record.id || index}`,
    source: 'memory',
    trust: 'untrusted_data',
    scope: record.scope === 'user' ? 'user' : 'project',
    egress: record.visibility === 'private' || record.scope === 'private' ? 'local_only' : 'allowed',
    content: record.content,
    priority: Math.round((record.importance * 0.6 + record.confidence * 0.4) * 100),
    provenance: {
      recordId: record.id,
      type: record.type,
      staleness: staleness(record),
      score: record.importance * 0.6 + record.confidence * 0.4,
    },
  }
}

function projectFragments(project: Project, workspace?: ProjectWorkspaceBinding | null): PromptFragment[] {
  if (!canAccessCloudProject(project)) throw new Error('Das Projekt gehört zu einem anderen Benutzer.')
  const fragments: PromptFragment[] = [
    {
      id: 'project-identity',
      source: 'project',
      trust: 'user_confirmed',
      scope: 'project',
      egress: 'allowed',
      priority: 100,
      content: JSON.stringify({ id: project.id, name: project.name, workspace_alias: '@project' }),
    },
    {
      id: 'project-workspace',
      source: 'project',
      trust: 'policy',
      scope: 'workspace',
      egress: 'allowed',
      priority: 100,
      content: JSON.stringify({
        bound: workspace?.status === 'ready',
        status: workspace?.status ?? 'unbound',
        alias: '@project',
        is_git_repository: workspace?.isGitRepository ?? false,
        rule: 'All file paths and coding-agent working directories are relative to @project. The absolute path is device-local.',
      }),
    },
  ]

  if (project.goal?.trim()) {
    fragments.push({
      id: 'project-overall-goal',
      source: 'project',
      trust: 'user_confirmed',
      scope: 'project',
      egress: 'allowed',
      priority: 95,
      content: project.goal,
    })
  }
  if (project.summary.trim()) {
    fragments.push({
      id: 'project-summary',
      source: 'project',
      trust: 'user_confirmed',
      scope: 'project',
      egress: 'allowed',
      priority: 90,
      content: project.summary,
    })
  }

  const activeGoals = project.goals
    .filter(goal => goal.status !== 'done')
    .sort((left, right) => {
      const priority = { high: 0, normal: 1, low: 2 }
      return (
        priority[left.priority ?? 'normal'] - priority[right.priority ?? 'normal'] || left.createdAt - right.createdAt
      )
    })
    .slice(0, 8)
  if (activeGoals.length) {
    fragments.push({
      id: 'project-active-goals',
      source: 'project',
      trust: 'user_confirmed',
      scope: 'project',
      egress: 'allowed',
      priority: 85,
      content: JSON.stringify(
        activeGoals.map(goal => ({
          title: goal.title,
          description: goal.description ?? '',
          status: goal.status,
          priority: goal.priority ?? 'normal',
        }))
      ),
    })
  }

  return fragments
}

/**
 * Build the stable provider-facing context for the first and every subsequent
 * turn of a project. Candidates, secrets, raw provenance and absolute local
 * paths are already excluded by Memory v2 and the prompt assembler.
 */
export async function buildProjectStartContext(
  options: ProjectStartContextOptions,
  dependencies: ProjectStartContextDependencies = defaultDependencies
): Promise<PromptContextAssembly & { sourceFragments: PromptFragment[] }> {
  const fragments = projectFragments(options.project, options.workspace)
  const memoryLimit = Math.max(0, Math.min(8, Math.round(options.memoryLimit ?? 5)))

  if (options.includeMemory !== false && memoryLimit > 0) {
    const userLimit = Math.min(2, memoryLimit)
    const projectLimit = Math.max(1, memoryLimit - userLimit)
    const [userMemory, projectMemory] = await Promise.all([
      dependencies.recall({ scope: 'user', query: '', limit: userLimit }).catch((): MemoryRecord[] => []),
      dependencies
        .recall({ scope: 'project', projectId: options.project.id, query: '', limit: projectLimit })
        .catch((): MemoryRecord[] => []),
    ])
    fragments.push(...[...userMemory, ...projectMemory].map(memoryFragment))
  }

  const assembled = assemblePromptContext(fragments, {
    maxChars: 6_000,
    maxEstimatedTokens: 1_500,
    maxFragments: 16,
    maxFragmentChars: 1_400,
    ...options.assembly,
  })
  return { ...assembled, sourceFragments: fragments }
}

export { projectFragments as projectStartFragments }
