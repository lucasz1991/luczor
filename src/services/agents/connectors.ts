// src/services/agents/connectors.ts
//
// SOLL §8b, mode B — PLACEHOLDER ONLY. The connector path (dedicated Claude/
// Codex connectors/integration points) is intentionally NOT implemented yet;
// this file establishes the contract + settings enum so the UI can offer the
// option ("in Vorbereitung") and a later change can drop in real drivers
// without touching callers. Do not wire this into the agent loop.

export type AgentConnectorMode = 'off' | 'api' | 'cli' | 'connector'

export type ConnectorDispatch = {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  result?: unknown
  error?: string
}

/** Contract a future connector implementation must satisfy. */
export interface AgentConnector {
  readonly name: string // e.g. "claude" | "codex"
  dispatch(prompt: string, opts?: Record<string, unknown>): Promise<ConnectorDispatch>
  status(dispatchId: string): Promise<ConnectorDispatch>
  result(dispatchId: string): Promise<ConnectorDispatch>
  cancel(dispatchId: string): Promise<void>
}

/** No connector is available yet — reserved for a future package. */
export function getAgentConnector(_name: string): AgentConnector | null {
  return null
}
