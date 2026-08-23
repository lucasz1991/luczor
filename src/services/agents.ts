// src/services/agents.ts
//
// Client wrapper for external coding-agent orchestration (SOLL §8b, mode C/D).
// Detects locally installed Claude Code / OpenAI Codex CLIs, runs them headless
// in a project directory, and writes the shared LUCZOR.md bridge file.

import { invoke } from '@tauri-apps/api/core'

export type AgentName = 'claude' | 'codex'
export type AgentInfo = { name: string; available: boolean; path: string | null }
export type AgentRunResult = {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  timed_out: boolean
  stdout_truncated: boolean
  stderr_truncated: boolean
}

export const detectAgents = () => invoke<AgentInfo[]>('agent_cli_detect')

export const runAgentCli = (agent: AgentName, prompt: string, projectDir?: string) =>
  invoke<AgentRunResult>('agent_cli_run', {
    payload: { agent, prompt, project_dir: projectDir ?? null },
  })

export const writeBridgeFile = (projectDir: string, content: string) =>
  invoke<string>('agent_write_bridge', { payload: { project_dir: projectDir, content } })

/** Build the LUCZOR.md bridge markdown from the current project state. */
export function buildBridgeMarkdown(project: {
  name?: string
  summary?: string
  goals?: Array<{ title: string; description?: string; status: string }>
}): string {
  const goals = (project.goals ?? [])
    .map(g => `- [${g.status}] ${g.title}${g.description ? ` — ${g.description}` : ''}`)
    .join('\n')
  return [
    '# LUCZOR.md — gemeinsamer Projektkontext',
    '',
    'Diese Datei wird von Luczor gepflegt und gibt lokalen Coding-Agenten',
    '(Claude Code, OpenAI Codex) gemeinsamen Kontext für die Zusammenarbeit.',
    '',
    `## Projekt\n${project.name ?? '(unbenannt)'}`,
    '',
    `## Zusammenfassung\n${project.summary?.trim() || '(noch keine)'}`,
    '',
    `## Ziele\n${goals || '(keine erfassten Ziele)'}`,
    '',
    '## Zusammenarbeit',
    '- Luczor orchestriert die Agenten und verteilt Teilaufgaben.',
    '- Trage relevante Ergebnisse/Änderungen hier ein, damit der jeweils andere Agent sie sieht.',
    '',
  ].join('\n')
}
