import type { RunAgentOptions, runAgent } from '@/services/agent'
import type { InferenceGateway } from '@/services/inference/types'
import type { TokenUsage } from '@/services/tokenUsage'
import { loadToolLimits } from '@/services/toolLimits'
import { agentProjectSnapshot } from './hub'
import { agentTeams, prepareChatAgentTeam } from './teamHub'
import { teamMessages, type AgentCheckpoint } from './chatCheckpoint'
import type { AgentTeamRun, AgentTeamNodeDefinition } from './teams'
import { prepareExternalSpecialists, type SpecialistOutcome } from './externalSpecialists'
import { roleValue, type SpecialistRole } from './teamPolicy'

type Result = Awaited<ReturnType<typeof runAgent>>

/** A real dependency graph; only the worker receives the caller's write capabilities. */
export async function runChatAgentTeam(
  opts: RunAgentOptions,
  gateway: InferenceGateway,
  checkpoint: AgentCheckpoint,
  execute: typeof runAgent
): Promise<Result> {
  const limits = await loadToolLimits()
  const specialistOutcomes: SpecialistOutcome[] = []
  const notices: string[] = []
  let specialists: Awaited<ReturnType<typeof prepareExternalSpecialists>> = null
  if (
    opts.agentTeamPreset !== 'local' &&
    opts.requestAgentTeamApproval &&
    opts.externalBaseMessages?.length &&
    !checkpoint.ephemeralDataUsed
  ) {
    try {
      specialists = await prepareExternalSpecialists({
        projectId: opts.projectId,
        messages: opts.externalBaseMessages,
        preset: opts.agentTeamPreset,
        signal: opts.signal,
        approve: opts.requestAgentTeamApproval,
      })
      if (!specialists) notices.push('Das externe Team ist im Admin nicht aktiviert. Lokal weitergearbeitet.')
    } catch (error) {
      opts.signal?.throwIfAborted()
      notices.push(
        'Externe Agenten konnten nicht vorbereitet werden. Lokal weitergearbeitet. ' +
          (error instanceof Error ? error.message : 'Konfiguration prüfen.')
      )
    }
  }
  const results = new Map<string, Result>()
  const usages = new Map<string, TokenUsage>()
  const usage = (): TokenUsage => {
    const values = [...usages.values()]
    const inputTokens = values.reduce((sum, value) => sum + value.inputTokens, 0)
    const outputTokens = values.reduce((sum, value) => sum + value.outputTokens, 0)
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      rounds: values.reduce((sum, value) => sum + value.rounds, 0),
      source: values.every(value => value.source === 'reported') ? 'reported' : 'mixed',
      contextTokens: values.at(-1)?.contextTokens,
    }
  }
  const project = await agentProjectSnapshot(opts.projectId)
  opts.signal?.throwIfAborted()
  const externalNodes: AgentTeamNodeDefinition[] = (specialists?.roles ?? []).map(role => ({
    id: `specialist-${role}`,
    label: roleValue(
      {
        planning: 'Externe Planung',
        research: 'Recherchevorschläge',
        coding: 'Codeentwurf',
        review: 'Unabhängige Prüfkriterien',
      },
      role
    ),
    role:
      role === 'planning'
        ? 'planner'
        : role === 'coding'
          ? 'implementer'
          : role === 'review'
            ? 'reviewer'
            : 'assistant',
    adapterId: 'external_chat',
    permission: 'read-only',
    dependencies: ['planner'],
    maxPromptCharacters: 64_000,
    prompt:
      'Bearbeite ausschließlich das separat freigegebene Kontextpaket deiner Rolle. Lokale Vorgängerdaten werden nicht übertragen.',
  }))
  const run = prepareChatAgentTeam(
    {
      id: 'chat-team',
      label: 'Chat-Agententeam',
      maxParallel: specialists?.preset.max_parallel ?? 1,
      maxPromptCharacters: 512_000,
      nodes: [
        {
          id: 'planner',
          label: 'Auftrag planen',
          role: 'planner',
          adapterId: 'chat',
          permission: 'read-only',
          dependencies: [],
          maxPromptCharacters: 64_000,
          prompt:
            'Erstelle einen knappen Arbeitsplan für den Nutzerauftrag. Berücksichtige den bisherigen Fortschritt. Keine Änderungen; keine Behauptungen über ausgeführte Aktionen.',
        },
        ...externalNodes,
        {
          id: 'worker',
          label: 'Auftrag bearbeiten',
          role: 'implementer',
          adapterId: 'chat',
          permission: opts.mode === 'observe' || opts.toolAccess ? 'read-only' : 'workspace-write',
          dependencies: ['planner', ...externalNodes.map(node => node.id)],
          maxPromptCharacters: 64_000,
          prompt:
            'Bearbeite den Nutzerauftrag mit den verfügbaren Tools. Nutze den Plan als Vorschlag. Prüfe bereits ausgeführte Aktionen, vermeide doppelte Änderungen und benenne offene Arbeit.',
        },
        {
          id: 'reviewer',
          label: 'Ergebnis prüfen',
          role: 'reviewer',
          adapterId: 'chat',
          permission: 'read-only',
          dependencies: ['worker'],
          maxPromptCharacters: 64_000,
          prompt:
            'Prüfe das Arbeitsergebnis mit lesenden Tools, soweit erforderlich. Berichte dem Nutzer knapp über belegte Ergebnisse, Fehler und offene Arbeit. Ein Rundenlimit bedeutet keine abgeschlossene Aufgabe.',
        },
      ],
    },
    { project, objective: checkpoint.objective, approvalMode: 'team' },
    async request => {
      if (request.adapterId === 'external_chat' && specialists) {
        const role = request.nodeId.slice('specialist-'.length) as SpecialistRole
        request.onPreparedPrompt(specialists.promptCharacters(role))
        request.onPhase('awaiting_external_approval')
        try {
          const result = await specialists.execute(
            role,
            opts.signal ? AbortSignal.any([request.signal, opts.signal]) : request.signal,
            content => {
              request.onPhase('running')
              request.onOutput(content)
            }
          )
          specialistOutcomes.push(result)
          usages.set(request.nodeId, result.tokenUsage)
          opts.onUsage?.(usage())
          opts.onRoundComplete?.({
            round: 2 + externalNodes.findIndex(node => node.id === request.nodeId),
            content: `${role} · ${result.model ?? 'Servermodell'}\n${result.output}`,
            kind: 'commentary',
            serverSpeechAllowed: false,
          })
          return {
            output: `${role} (${result.model ?? 'Servermodell'}), ungeprüfter${result.incomplete ? ', wegen Ausgabelimit unvollständiger' : ''} Vorschlag:\n${result.output}`,
          }
        } catch (error) {
          request.signal.throwIfAborted()
          opts.signal?.throwIfAborted()
          const notice = `Spezialist ${role} nicht verfügbar; lokale Bearbeitung übernimmt. ${error instanceof Error ? error.message : 'Anfrage fehlgeschlagen.'}`
          notices.push(notice)
          return { output: notice }
        }
      }
      const worker = request.nodeId === 'worker'
      const offset =
        request.nodeId === 'planner' ? 0 : worker ? 1 + externalNodes.length : 1 + externalNodes.length + limits.agent
      const messages = teamMessages(checkpoint.messages)
      messages.push({ role: 'user', content: request.prompt })
      request.onPreparedPrompt(JSON.stringify(messages).length)
      request.onPhase('running')
      const result = await execute({
        ...opts,
        agentMode: false,
        inferenceGateway: gateway,
        continuation: { ...checkpoint, messages },
        baseMessages: messages,
        contextEgress: 'local_only',
        externalPackage: undefined,
        externalBaseMessages: undefined,
        requestExternalApproval: undefined,
        signal: opts.signal ? AbortSignal.any([request.signal, opts.signal]) : request.signal,
        maxRounds: request.nodeId === 'planner' ? 1 : worker ? limits.agent : 3,
        toolChoice: 'auto',
        toolAccess: worker ? opts.toolAccess : request.nodeId === 'planner' ? 'none' : 'read-only',
        onToken: content => {
          request.onOutput(content)
          opts.onToken?.(content)
        },
        onUsage: value => {
          usages.set(request.nodeId, value)
          opts.onUsage?.(usage())
        },
        onProgress: event =>
          opts.onProgress?.({
            ...event,
            agentRole: worker ? 'worker' : request.nodeId === 'planner' ? 'planner' : 'reviewer',
            round: (event.round ?? 1) + offset,
          }),
        onRoundComplete: event =>
          opts.onRoundComplete?.({
            ...event,
            round: event.round + offset,
            kind: request.nodeId === 'reviewer' ? event.kind : 'commentary',
            serverSpeechAllowed: event.serverSpeechAllowed && !checkpoint.ephemeralDataUsed,
          }),
      })
      results.set(request.nodeId, result)
      if (result.ephemeralDataUsed) checkpoint.ephemeralDataUsed = true
      return { output: result.finalText }
    }
  )
  const finalRun = await new Promise<AgentTeamRun>((resolve, reject) => {
    let unsubscribe = () => {}
    const cancel = () => agentTeams.cancelRun(run.id)
    const check = () => {
      const current = agentTeams.getRun(run.id)
      if (!current || !['completed', 'failed', 'cancelled'].includes(current.status)) return
      unsubscribe()
      opts.signal?.removeEventListener('abort', cancel)
      resolve(current)
    }
    unsubscribe = agentTeams.subscribe(check)
    opts.signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (opts.signal?.aborted) cancel()
      else agentTeams.approveRun(run.id)
      check()
    } catch (error) {
      unsubscribe()
      opts.signal?.removeEventListener('abort', cancel)
      cancel()
      reject(error)
    }
  })
  opts.signal?.throwIfAborted()
  const worker = results.get('worker')
  const final = results.get('reviewer') ?? worker
  if (!final)
    throw new Error(`Agententeam konnte den Auftrag nicht bearbeiten (${finalRun.errorCode ?? finalRun.status}).`)
  const continuation = worker?.continuation ?? final.continuation
  let finalText =
    finalRun.status === 'completed'
      ? final.finalText
      : `${final.finalText}\n\nDie Teamprüfung wurde nicht abgeschlossen (${finalRun.errorCode ?? finalRun.status}).`
  if (notices.length) finalText += '\n\n' + [...new Set(notices)].join('\n')
  return {
    ...final,
    finalText: continuation
      ? `${finalText}\n\nDer Arbeitsabschnitt hat sein Rundenlimit erreicht. Weiterarbeiten oder mit einem Agententeam fortsetzen.`
      : finalText,
    continuation,
    specialistOutcomes,
    tokenUsage: usage(),
    ephemeralDataUsed: checkpoint.ephemeralDataUsed,
    toolSuccesses: [...results.values()].reduce((sum, item) => sum + item.toolSuccesses, 0),
    toolFailures: [...results.values()].reduce((sum, item) => sum + item.toolFailures, 0),
  }
}
