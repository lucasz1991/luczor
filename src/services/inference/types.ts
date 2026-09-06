export type LuczorMode = 'observe' | 'act' | 'unrestricted'
export type ToolChoice = 'auto' | 'required' | 'none'
export type InferenceTarget = 'local_llama_cpp' | 'laravel_proxy'

export type ApprovedProxyConfig = Readonly<{
  baseUrl: string
  deviceKey: string
  clientId: string
}>

export type WireToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      tool_calls?: WireToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; name?: string; content: string }

export type ParsedToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
  rawArguments: string
}

/** Counts actually reported by the model runtime/provider, never output limits. */
export type InferenceTokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type InferenceResult = {
  content: string
  toolCalls: ParsedToolCall[]
  rawToolCalls: WireToolCall[]
  finishReason: string
  requestId?: string
  correlationId?: string
  model?: string
  provider?: string
  useCase?: string
  routeDecisionId?: string
  target?: InferenceTarget
  usage?: InferenceTokenUsage
  contextUsage?: {
    inputTokens: number
    contextTokens: number
    outputTokens: number
    omittedMessages: number
    shortenedToolResults: number
  }
}

export type InferenceRequest = {
  messages: WireMessage[]
  tools?: unknown[]
  toolChoice?: ToolChoice
  projectId?: string
  taskType?: string
  contextId?: string
  repoId?: string
  branch?: string
  commitSha?: string
  inputSource?: 'keyboard' | 'push_to_talk' | 'hands_free'
  signal?: AbortSignal
  onToken?: (content: string) => void
  /**
   * Local authorization metadata. Never serialized into the proxy body. The
   * Laravel gateway re-hashes the final bytes immediately before `fetch`.
   */
  expectedProxyBodySha256?: string
  /** Immutable verified API identity; never serialized or logged. */
  expectedProxyConfig?: ApprovedProxyConfig
  /** Approval TTL, rechecked immediately before the proxy fetch. */
  expectedProxyApprovalExpiresAt?: string
}

/** One gateway instance is selected once and retained for the complete agent turn. */
export interface InferenceGateway {
  readonly id: string
  readonly target: InferenceTarget
  streamChatWithTools(request: InferenceRequest): Promise<InferenceResult>
}
