import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h, shallowReactive } from 'vue'
import * as VueRuntime from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, parse } from '@vue/compiler-sfc'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import DeviceTargetEditor from '@/components/workflows/WorkflowDeviceTargetEditor.vue'
import editorSource from '@/components/workflows/WorkflowDeviceTargetEditor.vue?raw'
import * as targetContract from '@/services/workflows/deviceTarget'
import { boundedWorkflowJson } from '@/services/workflows/operations'
import type { WorkflowDefinition, WorkflowDeviceTarget, WorkflowTask } from '@/services/workflows/types'

const catalog: WorkflowTask[] = ['browser.read', 'node.run', 'context'].map(key => ({
  key,
  label: key,
  version: 1,
  runner: key === 'context' ? 'server' : 'client',
  kind: 'task',
  mutating: false,
  requires_approval: false,
  allowed_in_definition: true,
  params: {},
}))
function editor(modelValue?: WorkflowDeviceTarget) {
  const { descriptor } = parse(editorSource, { filename: 'WorkflowDeviceTargetEditor.vue' })
  const compiled = compileScript(descriptor, { id: 'device-target-editor-test' })
  const module = {
    exports: {} as {
      default?: {
        setup: (
          props: unknown,
          context: unknown
        ) => {
          selectKind: (kind: string) => void
          setDeviceId: (value: string) => void
          setCapability: (value: string) => void
        }
      }
    },
  }
  runInNewContext(
    ts.transpileModule(compiled.content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      module,
      exports: module.exports,
      require: (path: string) => {
        if (path === 'vue') return VueRuntime
        if (path === '@/services/workflows/deviceTarget') return targetContract
        throw new Error(`Unexpected import ${path}`)
      },
    }
  )
  const props = shallowReactive({ modelValue, catalog, disabled: false })
  const emit = vi.fn((_event: string, value: WorkflowDeviceTarget | undefined) => {
    props.modelValue = value
  })
  return { props, emit, controls: module.exports.default!.setup(props, { emit, expose: () => {} }) }
}
describe('versioned workflow device targets', () => {
  it('keeps legacy targets implicit and edits a new draft without changing the frozen original', () => {
    const frozen: WorkflowDefinition = { steps: [{ key: 'read', type: 'browser.read', payload: {} }] }
    const draft = JSON.parse(boundedWorkflowJson(frozen)) as WorkflowDefinition
    const harness = editor()
    expect(harness.emit).not.toHaveBeenCalled()
    harness.controls.selectKind('specific')
    expect(() => targetContract.validateWorkflowDeviceTarget(harness.props.modelValue, catalog)).toThrow('Geräte-ID')
    harness.controls.setDeviceId(' linux-laptop ')
    draft.steps[0]!.device_target = harness.props.modelValue
    targetContract.validateWorkflowDeviceTargets(draft, catalog)
    expect(JSON.parse(boundedWorkflowJson(draft)).steps[0].device_target).toEqual({
      kind: 'specific',
      device_id: 'linux-laptop',
    })
    expect(frozen.steps[0]).not.toHaveProperty('device_target')
    harness.controls.selectKind('capability')
    harness.controls.setCapability('node.run')
    expect(harness.props.modelValue).toEqual({ kind: 'capability', task_type: 'node.run', task_version: 1 })
    harness.controls.selectKind('coordinator')
    expect(harness.props.modelValue).toEqual({ kind: 'coordinator' })
    harness.props.disabled = true
    harness.controls.selectKind('current')
    expect(harness.props.modelValue).toEqual({ kind: 'coordinator' })
    harness.props.disabled = false
    harness.controls.selectKind('current')
    expect(harness.props.modelValue).toBeUndefined()
  })
  it('rejects wrong fields, non-client capabilities, unsupported versions and nested invalid selectors', () => {
    for (const value of [
      { kind: { toString: () => 'current' } },
      { kind: 'current', device_id: 'unexpected' },
      { kind: 'specific', device_id: '' },
      { kind: 'specific', device_id: 'ü'.repeat(61) },
      { kind: 'capability', task_type: 'context' },
      { kind: 'capability', task_type: 'missing' },
      { kind: 'capability', task_version: 2 },
      { kind: 'specific', device_id: { $ref: 'input.device' } },
    ])
      expect(() => targetContract.validateWorkflowDeviceTarget(value, catalog)).toThrow()
    expect(() =>
      targetContract.validateWorkflowDeviceTargets(
        { steps: [{ key: 'server', type: 'context', payload: {}, device_target: { kind: 'current' } }] },
        catalog
      )
    ).toThrow('Geräteaufgaben')
    expect(() =>
      targetContract.validateWorkflowDeviceTargets(
        {
          steps: [
            {
              key: 'loop',
              type: 'control.foreach',
              payload: {
                body: {
                  steps: [
                    {
                      key: 'nested',
                      type: 'browser.read',
                      payload: {},
                      device_target: { kind: 'specific', device_id: '' },
                    },
                  ],
                },
              },
            },
          ],
        },
        catalog
      )
    ).toThrow('nested')
  })
  it('shows standard/current routing and validation without network calls or applying a live run override', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(DeviceTargetEditor, { catalog, disabled: true }) })
    )
    expect(html).toContain('Startgerät · Standard')
    expect(html).toContain('Koordinator')
    expect(html).toContain('Bestimmtes Gerät')
    expect(html).toContain('Passendes verfügbares Gerät')
    expect(html).toContain('laufende Aufträge behalten ihre Version')
    expect(html).toContain('disabled')
  })
})
