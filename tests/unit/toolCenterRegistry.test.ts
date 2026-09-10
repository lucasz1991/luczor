import { describe, expect, it } from 'vitest'
import { getTool, listTools } from '@/services/tools/registry'
import { MODEL_CONTROL_SCHEMA, validateModelControls } from '@/services/tools/modelControl'

describe('Tool-Center direct capabilities', () => {
  it('registers browser, vision, terminal and model controls in one registry', () => {
    const names = listTools().map(tool => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'browser_open',
        'browser_dom_read',
        'browser_screenshot',
        'browser_click',
        'image_analyze',
        'project_terminal_run',
        'model_capabilities',
        'model_control_validate',
      ])
    )
    expect(getTool('project_terminal_run')).toMatchObject({
      mutating: true,
      requiresApproval: true,
      dataHandling: 'ephemeral',
      capabilityKey: 'node.run',
      sessionKind: 'terminal',
      approvalMode: 'session',
      scope: 'project',
    })
  })

  it('validates expert model parameters and rejects unsupported raw fields', () => {
    expect(
      validateModelControls({
        inference: 'local',
        thinking_tier: 'balanced',
        temperature: 0.2,
        top_p: 0.9,
        max_output_tokens: 2048,
        output_format: 'json',
      })
    ).toMatchObject({ inference: 'local', output_format: 'json' })
    expect(() => validateModelControls({ provider_parameters: { temperature: 0.2 } })).toThrow()
    expect(() => validateModelControls({ temperature: 2.1 })).toThrow()
    expect(MODEL_CONTROL_SCHEMA.additionalProperties).toBe(false)
  })
})
