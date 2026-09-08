import type { Message, PendingToolCall, Project } from '@/state/types'
import type { MiniChatBinding } from './bridge'
import type { MiniProject, MiniMessage } from './types'

export function boundMiniMessages(messages: MiniMessage[]): MiniMessage[] {
  const bounded = messages.slice(-40).map(message => ({
    ...message,
    content: message.content.slice(0, 16_000),
    question: message.question?.slice(0, 1000),
    choices: message.choices.slice(0, 4).map(choice => choice.slice(0, 300)),
    commentary: message.commentary?.slice(-12).map(entry => ({ ...entry, content: entry.content.slice(0, 4000) })),
    activity: message.activity
      ? {
          ...message.activity,
          steps: message.activity.steps.slice(-12).map(step => ({
            ...step,
            id: step.id.slice(0, 160),
            label: step.label.slice(0, 200),
            detail: step.detail?.slice(0, 600),
          })),
        }
      : undefined,
  }))
  while (bounded.length > 1 && JSON.stringify(bounded).length > 100_000) bounded.shift()
  return bounded
}

export function miniProjectList(projects: Project[], messages: Message[], activity: Record<string, boolean> = {}): MiniProject[] {
  return projects
    .filter(project => !project.archivedAt)
    .slice(0, 200)
    .map(project => ({
      id: project.id,
      name: project.name.slice(0, 160),
      updatedAt: project.updatedAt,
      busy: !!activity[project.id],
      messageCount: messages.filter(
        message => message.projectId === project.id && message.visibility !== 'hidden' && message.role === 'user'
      ).length,
    }))
}

/** Read-only display projection; generation and persistence remain in App.send. */
export function projectChatBinding(
  project: Project | undefined,
  messages: Message[],
  tools: PendingToolCall[],
  busy: boolean
): MiniChatBinding {
  const visible = project
    ? messages.filter(
        message => message.projectId === project.id && message.visibility !== 'hidden' && message.role !== 'tool'
      )
    : []
  const binding: MiniChatBinding = {
    key: `${project?.id ?? 'none'}:${visible[0]?.id ?? 'empty'}`,
    project: project ? { id: project.id, name: project.name } : null,
    busy,
    messages: visible.slice(-40).map(message => ({
      id: message.id,
      role: message.role as 'user' | 'assistant',
      content: (message.meta.summary || message.content).slice(0, 16_000),
      createdAt: message.createdAt,
      status:
        message.meta.isLoading || message.meta.activity?.status === 'running'
          ? 'running'
          : message.meta.activity?.status === 'failed'
            ? 'failed'
            : message.meta.activity?.status === 'canceled'
              ? 'canceled'
              : 'done',
      question: message.meta.question?.slice(0, 1000),
      choices: (message.meta.bullets ?? []).slice(0, 4).map(choice => choice.slice(0, 300)),
      activity: message.meta.activity
        ? {
            ...message.meta.activity,
            steps: message.meta.activity.steps.slice(-12).map(step => ({
              ...step,
              id: step.id.slice(0, 160),
              label: step.label.slice(0, 200),
              detail: step.detail?.slice(0, 600),
            })),
          }
        : undefined,
      commentary: message.meta.commentary
        ?.slice(-12)
        .map(entry => ({ ...entry, content: entry.content.slice(0, 4000) })),
      tokenUsage: message.meta.tokenUsage,
    })),
    tools: tools
      .filter(tool => tool.projectId === project?.id)
      .slice(-12)
      .map(tool => ({ id: tool.id, name: tool.name, detail: '', status: tool.status })),
  }
  binding.messages = boundMiniMessages(binding.messages)
  return binding
}
