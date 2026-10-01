/* eslint-disable security/detect-non-literal-fs-filename -- Explicit isolated test path; schema and per-run identity are checked before reuse. */
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  assertDreamAcceptanceState,
  dreamSourceRevision,
  newDreamAcceptanceState,
  type DreamAcceptanceReceipt,
  type DreamAcceptanceState,
  type DreamAcceptanceStore,
} from './dreamAcceptance'

/** Explicit per-run file only. No application storage paths or accounts are inferred. */
export async function createDreamFileStore(file: string, runId: string): Promise<DreamAcceptanceStore> {
  const initial = newDreamAcceptanceState(runId)
  assertDreamAcceptanceState(initial, runId)
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(file, JSON.stringify(initial, null, 2), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const read = async () => {
    const state = JSON.parse(await readFile(file, 'utf8')) as DreamAcceptanceState
    assertDreamAcceptanceState(state, runId)
    return state
  }
  await read()
  let pending = Promise.resolve()
  return {
    read,
    commit(receipt: DreamAcceptanceReceipt, signal: AbortSignal) {
      const operation = pending.then(async () => {
        signal.throwIfAborted()
        const state = await read()
        if (state.receipts.some(item => item.id === receipt.id)) return
        if ((await dreamSourceRevision(state.sources)) !== receipt.revision) throw new Error('stale_source')
        state.receipts.push(structuredClone(receipt))
        const temporary = `${file}.${crypto.randomUUID()}.tmp`
        signal.throwIfAborted()
        try {
          await writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx' })
          signal.throwIfAborted()
          await rename(temporary, file)
        } finally {
          await rm(temporary, { force: true })
        }
      })
      pending = operation.catch(() => undefined)
      return operation
    },
  }
}
