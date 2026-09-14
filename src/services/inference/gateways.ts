import { OpenRouterService } from '@/services/openrouter.service'
import { traceInference } from '@/services/debugTrace'
import type { InferenceGateway, InferenceRequest } from '@/services/inference/types'

/** Current Laravel control-plane path, exposed through the provider-neutral contract. */
export const laravelInferenceGateway: InferenceGateway = Object.freeze({
  id: 'laravel-proxy',
  target: 'laravel_proxy',
  streamChatWithTools: (request: InferenceRequest) => traceInference('laravel_proxy', request, value => OpenRouterService.streamChatWithTools(value)),
})
