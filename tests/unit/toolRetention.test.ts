import { describe, expect, it } from 'vitest'
import { getTool } from '@/services/tools/registry'
import { toolRetentionPolicy } from '@/services/runs/toolRetention'

describe('built-in tool evidence retention', () => {
  it.each(['browser_dom_scan', 'fs_read', 'project_terminal_run', 'local_model_status'])(
    'retains %s locally without allowing provider/server egress',
    name => {
      const tool = getTool(name)!
      expect(tool).toBeDefined()
      expect(tool.dataHandling).toBe('ephemeral')
      expect(toolRetentionPolicy(tool, true)).toBe('local_only')
    }
  )
  it('keeps explicit volatile evidence and unknown custom-tool policies fail-closed', () => {
    const tool = getTool('local_model_status')!
    expect(toolRetentionPolicy({ ...tool, retentionPolicy: 'ephemeral' }, true)).toBe('ephemeral')
    expect(toolRetentionPolicy({ ...tool, name: 'custom_read' }, false)).toBe('ephemeral')
    expect(toolRetentionPolicy({ ...tool, retentionPolicy: 'local_only' }, false)).toBe('local_only')
  })
})
