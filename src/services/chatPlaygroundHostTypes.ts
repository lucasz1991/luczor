import type { PlaygroundAction } from './chatPlaygroundNative'

export type HostRequest = {
  sessionId: string
  requestId: string
  projectId: string
  conversationId: string
  action: PlaygroundAction
}
