export type WorkflowScriptEnvironment = {
  version: 1
  runtime_version: string
  dependencies: Array<{ name: string; version: string }>
  lock_path?: string
  lock_sha256?: string
}
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][A-Za-z0-9.-]+)?$/u
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function validateWorkflowScriptEnvironment(runtime: 'node' | 'python', value: unknown): WorkflowScriptEnvironment | undefined {
  if (value === undefined) return undefined
  if (!plain(value) || value.version !== 1 || Object.keys(value).some(key => !['version','runtime_version','dependencies','lock_path','lock_sha256'].includes(key))
    || typeof value.runtime_version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.runtime_version)
    || !Array.isArray(value.dependencies) || value.dependencies.length > 64) throw new Error('workflow_script_environment_invalid')
  const names = new Set<string>()
  for (const dep of value.dependencies) {
    if (!plain(dep) || Object.keys(dep).some(key => !['name','version'].includes(key)) || typeof dep.name !== 'string' || dep.name.length > 160
      || !(runtime === 'node' ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u : /^[A-Za-z0-9][A-Za-z0-9._-]*$/u).test(dep.name)
      || typeof dep.version !== 'string' || dep.version.length > 60 || !exactVersion.test(dep.version)) throw new Error('workflow_script_dependency_invalid')
    const name = runtime === 'python' ? dep.name.toLowerCase().replace(/[_.-]+/gu, '-') : dep.name
    if (names.has(name)) throw new Error('workflow_script_dependency_duplicate')
    names.add(name)
  }
  if (value.dependencies.length || value.lock_path !== undefined || value.lock_sha256 !== undefined) {
    if (typeof value.lock_path !== 'string' || value.lock_path.length > 500 || !value.lock_path
      || value.lock_path.split(/[\\/]/u).some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f]/u.test(part))
      || typeof value.lock_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.lock_sha256)) throw new Error('workflow_script_lock_invalid')
  }
  return structuredClone(value) as WorkflowScriptEnvironment
}
