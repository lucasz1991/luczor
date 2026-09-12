import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { coordinationApi } from '@/services/coordination/api'
import { executionGate } from '@/services/executionGate'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'
import type { ToolContext, ToolDef } from './types'
const id = { type: 'string', minLength: 1, maxLength: 190 }
async function access(ctx: ToolContext, mutating: boolean) {
  const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
  executionGate.assert(ticket, mutating)
  const owner = await getVerifiedAccountSnapshot()
  executionGate.assert(ticket, mutating)
  if (!owner) throw new Error('Für Geräteaufträge bitte am Luczor-Server anmelden.')
  if (ctx.inferenceTarget === 'external')
    throw new Error('Gerätedelegation wird durch das lokale Orchestrierungsmodell gesteuert.')
  return { owner, ticket, api: coordinationApi(owner.config, ticket.signal) }
}
const define = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  mutating: boolean,
  execute: ToolDef['execute']
): ToolDef => ({
  name,
  description,
  category: 'app',
  scope: 'network',
  risk: mutating ? 'sensitive' : 'low',
  effects: [mutating ? 'execute' : 'read'],
  mutating,
  requiresApproval: false,
  dataHandling: 'ephemeral',
  parameters: { type: 'object', additionalProperties: false, properties, required },
  execute,
})
export const deviceTools: ToolDef[] = [
  define(
    'device_list',
    'Eigene Geräte, aktuellen Koordinator und tatsächliche Erreichbarkeit anzeigen.',
    {},
    [],
    false,
    async (_args, ctx) => {
      const { api } = await access(ctx, false)
      return (await api.state()).data
    }
  ),
  define(
    'device_dispatch',
    'Einen gezielten Teilauftrag auf einem eigenen Gerät starten. Kehrt sofort mit Job-ID zurück; währenddessen unabhängig weiterarbeiten. Für Desktop-Eingaben zuerst desktop.observe und dessen frische observationId nutzen. chat.turn erhält nur explizite tool_allowlist-Rechte.',
    {
      target_device_id: id,
      tool_profile: {
        type: 'string',
        enum: [
          'chat.turn',
          'desktop.observe',
          'desktop.capture_screen',
          'desktop.windows.list',
          'desktop.clipboard.read',
          'desktop.input.move_mouse',
          'desktop.input.click',
          'desktop.input.type_text',
          'desktop.input.press_key',
          'desktop.open_url',
        ],
      },
      payload: { type: 'object', additionalProperties: true },
      operation_id: { type: 'string', format: 'uuid' },
    },
    ['target_device_id', 'tool_profile', 'payload', 'operation_id'],
    true,
    async (args, ctx) => {
      const { owner, ticket, api } = await access(ctx, true)
      const cluster = (await api.state()).data
      executionGate.assert(ticket, true)
      return (
        await api.dispatch({
          ...args,
          project_id: projectExternalIdForServer(ctx.projectId, owner.principalId),
          master_epoch: cluster.epoch,
        })
      ).data
    }
  ),
  define(
    'device_job_status',
    'Öffentlichen Fortschritt, Fehler und tatsächliche Ergebnisse eines Geräteauftrags abrufen. Nicht erneut delegieren, solange der Ausgang ungewiss ist.',
    { job_id: id },
    ['job_id'],
    false,
    async (args, ctx) => {
      const { api } = await access(ctx, false)
      return (await api.job(String(args.job_id))).data
    }
  ),
  define(
    'device_job_stop',
    'Nur den genannten Geräteauftrag stoppen; die Bestätigung des Zielgeräts wird getrennt gemeldet.',
    { job_id: id },
    ['job_id'],
    true,
    async (args, ctx) => {
      const { api, ticket } = await access(ctx, true)
      const cluster = (await api.state()).data
      executionGate.assert(ticket, true)
      return api.cancel(String(args.job_id), cluster.epoch)
    }
  ),
]
