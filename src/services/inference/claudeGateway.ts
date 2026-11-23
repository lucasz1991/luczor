import { laravelInferenceGateway } from './gateways'
import { hashLaravelProxyBody } from './laravelProxyBody'
import { LocalInferenceError } from './localModelManager'
import type { ClaudeEffort } from './claudeMain'
import type { ApprovedProxyConfig, InferenceGateway, InferenceRequest, InferenceResult } from './types'

export const CLAUDE_MAIN_TASK_TYPE = 'chat.main'

/** Raised when the provider declined a round. The partial text of that round is never an answer. */
export class ProviderRefusalError extends LocalInferenceError {
  constructor(
    readonly category: string | undefined,
    readonly phase: 'before_output' | 'mid_stream'
  ) {
    super('Claude hat diese Anfrage nicht bearbeitet.', 'provider_refusal', false, false)
    this.name = 'ProviderRefusalError'
  }
}

const SERVER_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  claude_modes_disabled: 'Claude als Hauptmodell ist auf dem Server nicht freigegeben.',
  claude_access_missing:
    'Für dieses Konto ist kein Claude-Zugang hinterlegt. Bitte unter Einstellungen → Claude API einrichten.',
  claude_model_not_allowed: 'Das gewählte Claude-Modell ist nicht mehr freigegeben. Bitte im Eingabefeld neu wählen.',
  claude_key_invalid:
    'Der hinterlegte Claude-Schlüssel wurde von Anthropic abgelehnt. Bitte unter Einstellungen → Claude API prüfen.',
  provider_auth_failed:
    'Der hinterlegte Claude-Schlüssel wurde von Anthropic abgelehnt. Bitte unter Einstellungen → Claude API prüfen.',
})

/** Map a proxy failure to a safe, fixed message. The upstream body is never echoed into the chat. */
function claudeProxyFailure(error: unknown): LocalInferenceError | undefined {
  if (!(error instanceof Error) || error instanceof LocalInferenceError) return undefined
  const match = /^OpenRouter HTTP (\d{3}):/u.exec(error.message)
  if (!match) {
    return error instanceof TypeError
      ? new LocalInferenceError(
          'Der Luczor-Server ist nicht erreichbar. Claude kann gerade nicht antworten.',
          'claude_server_unreachable',
          true,
          false
        )
      : undefined
  }
  const status = Number(match[1])
  const code = /"(?:error_code|code)"\s*:\s*"([a-z0-9_]{1,64})"/u.exec(error.message)?.[1] ?? ''
  // `code` is matched against a fixed table of own keys only.
  const known = Object.hasOwn(SERVER_ERRORS, code) ? SERVER_ERRORS[code as keyof typeof SERVER_ERRORS] : undefined
  if (known) return new LocalInferenceError(known, code, false, false)
  if (status === 429)
    return new LocalInferenceError(
      'Das Anfragelimit für Claude ist erreicht. Bitte kurz warten und erneut senden.',
      'claude_rate_limited',
      true,
      false
    )
  if (status === 401 || status === 403)
    return new LocalInferenceError(
      'Der Luczor-Server hat die Claude-Anfrage nicht zugelassen. Bitte Anmeldung und Freigaben prüfen.',
      'claude_not_permitted',
      false,
      false
    )
  if (status >= 500)
    return new LocalInferenceError(
      'Claude ist vorübergehend nicht verfügbar. Der Auftrag bleibt erhalten; bitte erneut senden oder lokal fortsetzen.',
      'claude_unavailable',
      true,
      false
    )
  return new LocalInferenceError(
    'Die Claude-Anfrage wurde vom Server abgelehnt. Details stehen im Diagnosebericht.',
    'claude_request_rejected',
    false,
    false
  )
}

export type ClaudeGatewayOptions = {
  /** Verified destination and device identity captured when the turn was admitted. */
  apiConfig: ApprovedProxyConfig
  modelProfile: string
  effort: ClaudeEffort
  /** Upper bound of provider requests for this one user turn, including corrections. */
  maxRequests: number
  /** The turn-bound authorization ends here even if the loop is still running. */
  expiresAt: number
  now?: () => number
  /** Test seam; production uses the Laravel proxy transport. */
  transport?: Pick<InferenceGateway, 'streamChatWithTools'>
}

/**
 * Claude as the main model: one gateway per user turn, several model/tool rounds.
 *
 * Unlike the packet-bound external route this authorization covers the whole turn — choosing a
 * Claude mode for the chat is the standing consent. It stays bound to the captured server
 * identity, one model profile, an expiry and a request ceiling, and every round is still hashed
 * so the transport sends exactly the bytes built here.
 */
export function createClaudeMainGateway(options: ClaudeGatewayOptions): InferenceGateway {
  const now = options.now ?? Date.now
  const transport = options.transport ?? laravelInferenceGateway
  let requests = 0
  return Object.freeze({
    id: `laravel:claude-main:${options.modelProfile}`,
    target: 'laravel_proxy' as const,
    async streamChatWithTools(request: InferenceRequest): Promise<InferenceResult> {
      if (options.expiresAt <= now())
        throw new LocalInferenceError(
          'Die Freigabe dieser Claude-Anfrage ist abgelaufen. Bitte erneut senden.',
          'claude_turn_expired',
          false,
          false
        )
      if (requests >= options.maxRequests)
        throw new LocalInferenceError(
          'Das Rundenlimit dieser Claude-Anfrage ist erreicht.',
          'claude_round_limit',
          false,
          false
        )
      requests++
      const outgoing: InferenceRequest = {
        ...request,
        taskType: CLAUDE_MAIN_TASK_TYPE,
        mainModelProfile: options.modelProfile,
        effort: options.effort,
        // The provider rejects a forced tool choice; the server would rewrite it anyway.
        toolChoice: request.toolChoice === 'none' ? 'none' : 'auto',
      }
      const packetHash = await hashLaravelProxyBody(outgoing, options.apiConfig.clientId, true)
      let result: InferenceResult
      try {
        result = await transport.streamChatWithTools({
          ...outgoing,
          expectedProxyBodySha256: packetHash,
          expectedProxyConfig: options.apiConfig,
          expectedProxyApprovalExpiresAt: new Date(options.expiresAt).toISOString(),
        })
      } catch (error) {
        throw claudeProxyFailure(error) ?? error
      }
      if (result.refusal) throw new ProviderRefusalError(result.refusal.category, result.refusal.phase)
      return result
    },
  })
}
