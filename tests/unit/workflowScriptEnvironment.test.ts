import { describe, expect, it, vi } from 'vitest'
import { validateWorkflowScriptEnvironment } from '@/services/workflows/scriptEnvironment'
import { runWorkflowTask, type WorkflowTaskPrimitives } from '@/services/workflowTaskRunner'
const base = { version: 1, runtime_version: '22.22.0', dependencies: [] }
const locked = {
  ...base,
  dependencies: [{ name: '@scope/package', version: '1.2.3' }],
  lock_path: 'locks/package-lock.json',
  lock_sha256: 'a'.repeat(64),
}
describe('versioned project-local script environments', () => {
  it('preserves old scripts and copies the literal reviewed environment', () => {
    expect(validateWorkflowScriptEnvironment('node', undefined)).toBeUndefined()
    const copy = validateWorkflowScriptEnvironment('node', locked)
    expect(copy).toEqual(locked)
    expect(copy).not.toBe(locked)
    expect(validateWorkflowScriptEnvironment('python', { ...base, runtime_version: '3.12.4' })).toEqual({
      ...base,
      runtime_version: '3.12.4',
    })
  })
  it.each(['../lock.json', '/absolute', 'C:/lock', '\\\\host\\lock', 'lock/./file', 'lock\nfile'])(
    'rejects unbound lock paths: %s',
    path => {
      expect(() => validateWorkflowScriptEnvironment('node', { ...locked, lock_path: path })).toThrow('lock_invalid')
    }
  )
  it.each(['latest', '^1.0.0', '1.*', '1.0.0 --flag', 'https://host/code', '1.0'])(
    'requires fixed dependency versions: %s',
    version => {
      expect(() =>
        validateWorkflowScriptEnvironment('node', { ...locked, dependencies: [{ name: 'package', version }] })
      ).toThrow('dependency_invalid')
    }
  )
  it('requires a complete lock pair and rejects duplicate normalized Python packages or arbitrary provisioning flags', () => {
    expect(() => validateWorkflowScriptEnvironment('node', { ...locked, lock_sha256: undefined })).toThrow(
      'lock_invalid'
    )
    expect(() => validateWorkflowScriptEnvironment('node', { ...base, global: true })).toThrow('environment_invalid')
    expect(() =>
      validateWorkflowScriptEnvironment('python', {
        ...locked,
        dependencies: [
          { name: 'my_pkg', version: '1.0.0' },
          { name: 'My-Pkg', version: '1.0.0' },
        ],
      })
    ).toThrow('dependency_duplicate')
  })
  it('sends environment alongside exact code and separate JSON input and keeps measured package integrity', async () => {
    const runScript = vi.fn().mockResolvedValue({
      ok: true,
      code: 0,
      stdout: '{"result":42}',
      stderr: '',
      timed_out: false,
      environment: {
        revision: 'b'.repeat(64),
        installed_sha256: 'c'.repeat(64),
        lock_sha256: locked.lock_sha256,
        dependency_count: 1,
        reused: true,
      },
    })
    const result = await runWorkflowTask(
      {
        task_key: 'node.run',
        params: { code: 'console.log(JSON.stringify({result:42}))', input: { amount: 7 }, environment: locked },
        workflow: { run: 'test-run', step_id: 7, step_key: 'script' },
      },
      { runScript } as unknown as WorkflowTaskPrimitives
    )
    expect(runScript).toHaveBeenCalledWith(
      'node',
      'console.log(JSON.stringify({result:42}))',
      undefined,
      { amount: 7 },
      locked
    )
    expect(result).toMatchObject({
      data: { result: 42 },
      environment: { reused: true, installed_sha256: 'c'.repeat(64) },
    })
  })
})
