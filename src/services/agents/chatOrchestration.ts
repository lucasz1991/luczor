import type { AgentRunEvaluation, RunAgentOptions, runAgent } from '@/services/agent'
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

const NESTED_AGENT_START_TOOLS = [
  'agent_dispatch',
  'agent_job_prepare',
  'agent_team_prepare',
  'workspace_agent_prepare',
] as const

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
  let latestWorkerCheckpoint = structuredClone(checkpoint)
  let reviewerRecoveryCheckpoint: AgentCheckpoint | undefined
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
  const agentRunEvaluations = (): AgentRunEvaluation[] =>
    (['planner', 'worker', 'reviewer'] as const).flatMap(role => {
      const result = results.get(role)
      if (!result?.requestId) return []
      return [
        {
          requestId: result.requestId,
          role,
          toolFailures: result.toolFailures,
          toolSuccesses: result.toolSuccesses,
          continuation: Boolean(result.continuation),
          interrupted: result.interrupted,
        },
      ]
    })
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
      const nodeCheckpoint = request.nodeId === 'reviewer' ? latestWorkerCheckpoint : checkpoint
      const messages = teamMessages(nodeCheckpoint.messages)
      messages.push({ role: 'user', content: request.prompt })
      if (request.nodeId === 'reviewer')
        reviewerRecoveryCheckpoint = {
          ...structuredClone(nodeCheckpoint),
          messages: structuredClone(messages),
          toolAccess: 'read-only',
        }
      request.onPreparedPrompt(JSON.stringify(messages).length)
      request.onPhase('running')
      const result = await execute({
        ...opts,
        agentMode: false,
        inferenceGateway: gateway,
        continuation: { ...nodeCheckpoint, messages },
        baseMessages: messages,
        contextEgress: 'local_only',
        externalPackage: undefined,
        externalBaseMessages: undefined,
        requestExternalApproval: undefined,
        signal: opts.signal,
        interruptionSignal: request.signal,
        maxRounds: request.nodeId === 'planner' ? 1 : worker ? limits.agent : 3,
        toolChoice: 'auto',
        toolAccess: worker ? opts.toolAccess : request.nodeId === 'planner' ? 'none' : 'read-only',
        disabledTools: [...new Set([...(opts.disabledTools ?? []), ...NESTED_AGENT_START_TOOLS])],
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
        onCheckpoint: worker
          ? async value => {
              latestWorkerCheckpoint = structuredClone(value)
              await opts.onCheckpoint?.(value)
            }
          : undefined,
      })
      results.set(request.nodeId, result)
      if (worker && result.continuation) latestWorkerCheckpoint = structuredClone(result.continuation)
      if (result.ephemeralDataUsed) checkpoint.ephemeralDataUsed = true
      if (result.ephemeralDataUsed) latestWorkerCheckpoint.ephemeralDataUsed = true
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
  const plannerNode = finalRun.nodes.find(node => node.id === 'planner')
  const workerNode = finalRun.nodes.find(node => node.id === 'worker')
  const reviewerNode = finalRun.nodes.find(node => node.id === 'reviewer')
  const plannerAttempt = results.get('planner')
  const workerAttempt = results.get('worker')
  const reviewerAttempt = results.get('reviewer')
  const planner = plannerNode?.status === 'completed' ? plannerAttempt : undefined
  const worker = workerNode?.status === 'completed' ? workerAttempt : undefined
  const reviewer = reviewerNode?.status === 'completed' ? reviewerAttempt : undefined
  const final = reviewer && !reviewer.interrupted ? reviewer : (worker ?? reviewer)
  if (!final) {
    if (planner && finalRun.status === 'failed' && workerNode?.status !== 'completed') {
      const code = workerNode?.errorCode ?? finalRun.errorCode ?? 'execution_failed'
      let finalText = `Der Arbeitsagent wurde vor dem Abschluss unterbrochen (${code}). Der vor dem Teamstart gesicherte Fortschritt bleibt erhalten. Bereits ausgelöste Änderungen können trotzdem ausgeführt worden sein. Lies beim Fortsetzen zuerst den aktuellen Projekt- und Aufgabenstand neu ein, bevor du weitere Änderungen vornimmst.`
      if (notices.length) finalText += '\n\n' + [...new Set(notices)].join('\n')
      return {
        ...planner,
        finalText,
        requestId: undefined,
        model: undefined,
        provider: undefined,
        useCase: undefined,
        routeDecisionId: undefined,
        continuation: workerAttempt?.continuation ?? latestWorkerCheckpoint,
        interrupted: {
          code,
          message: 'Der Arbeitsagent wurde vor dem Abschluss unterbrochen.',
        },
        specialistOutcomes,
        tokenUsage: usage(),
        ephemeralDataUsed: checkpoint.ephemeralDataUsed,
        toolSuccesses: [...results.values()].reduce((sum, item) => sum + item.toolSuccesses, 0),
        toolFailures: [...results.values()].reduce((sum, item) => sum + item.toolFailures, 0),
        agentRunEvaluations: agentRunEvaluations(),
      }
    }
    if (finalRun.status === 'failed' && plannerNode?.status !== 'completed') {
      const code = plannerNode?.errorCode ?? finalRun.errorCode ?? 'execution_failed'
      return {
        finalText: `Der Planungsagent wurde vor dem ersten Ergebnis unterbrochen (${code}). Der gesicherte Auftrag bleibt erhalten. Du kannst das Agententeam erneut starten; Luczor baut den Modellkontext dabei neu auf.`,
        continuation: checkpoint,
        interrupted: {
          code,
          message: 'Der Planungsagent wurde vor dem ersten Ergebnis unterbrochen.',
        },
        specialistOutcomes,
        tokenUsage: usage(),
        ephemeralDataUsed: checkpoint.ephemeralDataUsed,
        toolSuccesses: 0,
        toolFailures: 0,
        agentRunEvaluations: agentRunEvaluations(),
        inferenceTarget: gateway.target,
      }
    }
    throw new Error(`Agententeam konnte den Auftrag nicht bearbeiten (${finalRun.errorCode ?? finalRun.status}).`)
  }
  const reviewerFailure =
    !reviewer && finalRun.status === 'failed' && reviewerNode?.status !== 'completed'
      ? {
          code: reviewerNode?.errorCode ?? finalRun.errorCode ?? 'execution_failed',
          message: 'Der Prüfagent wurde vor dem Abschluss unterbrochen.',
        }
      : undefined
  const reviewContinuationSource =
    reviewer?.continuation ??
    reviewerAttempt?.continuation ??
    (reviewerFailure ? reviewerRecoveryCheckpoint : undefined)
  const reviewContinuation = reviewContinuationSource
    ? { ...structuredClone(reviewContinuationSource), toolAccess: 'read-only' as const }
    : undefined
  const continuation = worker?.continuation ?? reviewContinuation ?? final.continuation
  const interruption = worker?.interrupted ?? reviewer?.interrupted ?? final.interrupted ?? reviewerFailure
  const continuationNotice = interruption
    ? 'Der Arbeitsabschnitt wurde nach einer lokalen Modellstörung mit gesichertem Fortschritt beendet. Du kannst weiterarbeiten; Luczor liest dabei den aktuellen Zustand erneut ein.'
    : 'Der Arbeitsabschnitt hat sein Rundenlimit erreicht. Weiterarbeiten oder mit einem Agententeam fortsetzen.'
  const incompleteReview = reviewer?.interrupted ?? reviewerFailure
  const incompleteReviewText = reviewer?.interrupted
    ? `Die Teamprüfung wurde nicht abgeschlossen (${incompleteReview?.code}); die Prüfrunde endete aufgrund einer lokalen Modellstörung.`
    : `Die Teamprüfung wurde nicht abgeschlossen (${incompleteReview?.code}).`
  let finalText = incompleteReview
    ? `${worker?.finalText ?? final.finalText}\n\n${incompleteReviewText}`
    : finalRun.status === 'completed'
      ? final.finalText
      : `${final.finalText}\n\nDie Teamprüfung wurde nicht abgeschlossen (${finalRun.errorCode ?? finalRun.status}).`
  if (notices.length) finalText += '\n\n' + [...new Set(notices)].join('\n')
  const responseRequestId =
    interruption || worker?.continuation
      ? undefined
      : reviewContinuation
        ? (reviewer?.requestId ?? reviewerAttempt?.requestId)
        : final.requestId
  return {
    ...final,
    requestId: responseRequestId,
    finalText: continuation ? `${finalText}\n\n${continuationNotice}` : finalText,
    continuation,
    specialistOutcomes,
    tokenUsage: usage(),
    ephemeralDataUsed: checkpoint.ephemeralDataUsed,
    toolSuccesses: [...results.values()].reduce((sum, item) => sum + item.toolSuccesses, 0),
    toolFailures: [...results.values()].reduce((sum, item) => sum + item.toolFailures, 0),
    interrupted: interruption,
    agentRunEvaluations: agentRunEvaluations(),
  }
}
