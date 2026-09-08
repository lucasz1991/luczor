import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  FLASH_NEXT_MODEL_ID,
  ORCAROUTER_FALLBACK_MODEL_ID,
  isExecutableLocalModel,
  verifyLocalModelManifest,
  type NativeManifestVerifier,
} from '@/services/inference/modelManifest'

const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/local-model-manifest-v1.json'), 'utf8')) as {
  cases: Record<string, Record<string, unknown>>
}
const fixtureCases = new Map([
  ['metadata_only_default', fixture.cases.metadata_only_default!],
  ['explicit_experiment', fixture.cases.explicit_experiment!],
  ['promoted_preferred', fixture.cases.promoted_preferred!],
])
const hash = 'a'.repeat(64)
const trustDomain = `server:v1:${'b'.repeat(64)}`
const acceptanceSessionId = '00000000-0000-4000-8000-000000000001'

function envelope(payload: Record<string, unknown>) {
  return {
    key_id: 'test-key',
    algorithm: 'RSA-SHA256',
    payload_sha256: hash,
    payload: structuredClone(payload),
    signature: 'test-signature',
  }
}

function verifier(valid = true): NativeManifestVerifier {
  return {
    verify: vi.fn(async () => ({ valid, canonicalPayloadSha256: hash })),
  }
}

function verifyCase(name: string) {
  const payload = fixtureCases.get(name)
  if (!payload) throw new Error(`Unknown fixture case: ${name}`)
  return verifyPayload(payload)
}

function verifyPayload(payload: Record<string, unknown>, nativeVerifier = verifier()) {
  return verifyLocalModelManifest(envelope(payload), nativeVerifier, {
    trustDomain,
    acceptanceSessionId,
    acceptanceGeneration: 1,
    expectedKeyId: 'test-key',
    minimumCatalogVersion: 2026083001,
    minimumPolicyVersion: 2026083001,
    now: new Date('2026-08-30T12:30:00Z'),
  })
}

describe('signed local-model manifest normalization', () => {
  it('keeps an omitted accelerator scope absent in both the signed wire payload and normalized policy', async () => {
    const payload = structuredClone(fixture.cases.explicit_experiment!)
    const wireBefore = JSON.stringify(envelope(payload))
    const nativeVerifier = verifier()
    const manifest = await verifyPayload(payload, nativeVerifier)

    expect(nativeVerifier.verify).toHaveBeenCalledExactlyOnceWith(envelope(payload), expect.any(Object))
    expect(JSON.stringify(envelope(payload))).toBe(wireBefore)
    for (const model of manifest.models) {
      expect(model.capacityPolicy).not.toHaveProperty('acceleratorMemoryScope')
    }
  })

  it.each(['single_device', 'compatible_group'] as const)(
    'preserves an explicitly signed accelerator scope without changing numeric limits: %s',
    async scope => {
      const payload = structuredClone(fixture.cases.explicit_experiment!)
      const model = (payload.models as Array<Record<string, unknown>>)[0]!
      const nativeVerifier = verifier()
      const baseline = await verifyCase('explicit_experiment')
      ;(model.capacity_policy as Record<string, unknown>).accelerator_memory_scope = scope

      const manifest = await verifyPayload(payload, nativeVerifier)

      expect(nativeVerifier.verify).toHaveBeenCalledExactlyOnceWith(envelope(payload), expect.any(Object))
      expect(manifest.models[0]!.capacityPolicy).toEqual({
        ...baseline.models[0]!.capacityPolicy,
        acceleratorMemoryScope: scope,
      })
      expect(manifest.models[1]!.capacityPolicy).not.toHaveProperty('acceleratorMemoryScope')
    }
  )

  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'empty', value: '' },
    { label: 'unknown', value: 'all' },
    { label: 'alternate spelling', value: 'single-device' },
    { label: 'wrong case', value: 'COMPATIBLE_GROUP' },
    { label: 'whitespace', value: ' compatible_group ' },
    { label: 'boolean', value: false },
    { label: 'number', value: 1 },
    { label: 'object', value: { scope: 'compatible_group' } },
    { label: 'single-device array', value: ['single_device'] },
    { label: 'group array', value: ['compatible_group'] },
  ])('rejects non-enum accelerator scope before native acceptance: $label', async ({ value }) => {
    const payload = structuredClone(fixture.cases.explicit_experiment!)
    const model = (payload.models as Array<Record<string, unknown>>)[0]!
    ;(model.capacity_policy as Record<string, unknown>).accelerator_memory_scope = value
    const nativeVerifier = verifier()

    await expect(verifyPayload(payload, nativeVerifier)).rejects.toThrow('GPU-Speicherzuordnung')
    expect(nativeVerifier.verify).not.toHaveBeenCalled()
  })

  it.each(['valid', 'traversal', 'duplicate', 'backend', 'hash'])(
    'validates optional GPU runtime pins: %s',
    async variant => {
      const payload = structuredClone(fixture.cases.explicit_experiment!)
      const model = (payload.models as Array<Record<string, unknown>>).find(
        item => item.id === ORCAROUTER_FALLBACK_MODEL_ID
      )!
      const pinned = model.runtime as Record<string, unknown>
      pinned.backend = variant === 'backend' ? 'shell' : 'cuda'
      pinned.files = [
        {
          name: variant === 'traversal' ? '../ggml-cuda.dll' : 'ggml-cuda.dll',
          sha256: variant === 'hash' ? 'bad' : 'b'.repeat(64),
        },
      ]
      if (variant === 'duplicate') (pinned.files as unknown[]).push({ name: 'GGML-CUDA.DLL', sha256: 'c'.repeat(64) })
      const result = verifyLocalModelManifest(envelope(payload), verifier(), {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        now: new Date('2026-08-30T12:30:00Z'),
      })
      const normalized = result.then(
        manifest => {
          const runtime = manifest.models.find(item => item.id === ORCAROUTER_FALLBACK_MODEL_ID)?.runtime
          return { backend: runtime?.backend, files: runtime?.files }
        },
        () => ({ rejected: true })
      )
      await expect(normalized).resolves.toEqual(
        variant === 'valid' ? { backend: 'cuda', files: pinned.files } : { rejected: true }
      )
    }
  )

  it('keeps the desktop copies byte-identical to the published contract vectors', () => {
    const expected = [
      [
        readFileSync(resolve('tests/fixtures/local-model-manifest-v1.json')),
        'aea42329ee189bf641d11b36415f95a4044edf9ec16600b0aec5471f62788c30',
      ],
      [
        readFileSync(resolve('tests/fixtures/local-model-manifest-golden-envelope.json')),
        'fc7fd7bde369161f5eead0aa05da00fafbe297ea7903dac49f670feb91ff129b',
      ],
      [
        readFileSync(resolve('tests/fixtures/local-model-manifest-golden-canonical.json')),
        '5cd9a73b861a0b4b3b5ba62189c4ec2f76eb59ee1080a2b812d5e294e378bb3a',
      ],
      [
        readFileSync(resolve('tests/fixtures/local-model-manifest-test-public.pem')),
        '4237884b412c475693bd8d8b1edec5eab6c7b14161b15a49db8261f5319aadd5',
      ],
    ] as const
    for (const [bytes, expectedHash] of expected) {
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash)
    }
  })

  it('accepts disabled metadata without making either release executable', async () => {
    const manifest = await verifyCase('metadata_only_default')
    expect(manifest.routing.defaultModelId).toBe(ORCAROUTER_FALLBACK_MODEL_ID)
    expect(manifest.models.every(model => !model.enabled && !isExecutableLocalModel(model))).toBe(true)
  })

  it('rejects bootstrap discovery drift before native verification can persist it', async () => {
    const nativeVerifier = verifier()
    await expect(
      verifyLocalModelManifest(envelope(fixture.cases.metadata_only_default!), nativeVerifier, {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        expectedSchemaVersion: 1,
        expectedCatalogVersion: 2026083002,
        expectedPolicyVersion: 2026083001,
        now: new Date('2026-08-30T12:30:00Z'),
      })
    ).rejects.toThrow('Bootstrap discovery')
    expect(nativeVerifier.verify).not.toHaveBeenCalled()
  })

  it('normalizes the exact PHP golden envelope including uppercase GGUF quantization', async () => {
    const golden = JSON.parse(
      readFileSync(resolve('tests/fixtures/local-model-manifest-golden-envelope.json'), 'utf8')
    ) as Record<string, unknown>
    const parsed = await verifyLocalModelManifest(
      golden,
      {
        verify: async () => ({
          valid: true,
          canonicalPayloadSha256: '1ca6b2f8aedc633ec7f1685d8cc0c89485ffaa2d9e79224e32627d962eba1e0c',
        }),
      },
      {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'luczor-local-model-test-2026-01',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        now: new Date('2026-08-30T12:30:00Z'),
      }
    )
    expect(parsed.models.map(model => model.artifact?.quantization)).toEqual(['Q4_K_M', 'Q4_K_M'])
  })

  it('keeps enabled/unpromoted Flash explicit while Orca remains the signed default', async () => {
    const manifest = await verifyCase('explicit_experiment')
    const flash = manifest.models.find(model => model.id === FLASH_NEXT_MODEL_ID)!
    expect(flash).toMatchObject({ enabled: true, promoted: false, releaseChannel: 'experimental' })
    expect(manifest.routing.experimentalModelIds).toEqual([FLASH_NEXT_MODEL_ID])
    expect(manifest.routing.defaultModelId).toBe(ORCAROUTER_FALLBACK_MODEL_ID)
  })

  it('requires promoted Flash to be stable and makes it the signed default', async () => {
    const manifest = await verifyCase('promoted_preferred')
    const flash = manifest.models.find(model => model.id === FLASH_NEXT_MODEL_ID)!
    expect(flash).toMatchObject({ enabled: true, promoted: true, releaseChannel: 'stable' })
    expect(manifest.routing.defaultModelId).toBe(FLASH_NEXT_MODEL_ID)
    expect(manifest.routing.experimentalModelIds).toEqual([])
  })

  it('deep-freezes every verified nested policy and release object', async () => {
    const manifest = await verifyCase('explicit_experiment')
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.routing)).toBe(true)
    expect(Object.isFrozen(manifest.routing.requiredLocalState)).toBe(true)
    expect(Object.isFrozen(manifest.models[0]?.artifact)).toBe(true)
    expect(() => manifest.routing.requiredLocalState.push('bypass')).toThrow()
  })

  it('rejects promotion/channel drift, old capacity fields, crypto failure, expiry and downgrade', async () => {
    const promoted = structuredClone(fixture.cases.promoted_preferred!)
    ;(promoted.models as Array<Record<string, unknown>>)[0]!.release_channel = 'experimental'
    await expect(
      verifyLocalModelManifest(envelope(promoted), verifier(), {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        now: new Date('2026-08-30T12:30:00Z'),
      })
    ).rejects.toThrow('Promotion')

    const oldCapacity = structuredClone(fixture.cases.explicit_experiment!)
    const capacity = ((oldCapacity.models as Array<Record<string, unknown>>)[0]!.capacity_policy ?? {}) as Record<
      string,
      unknown
    >
    capacity.min_available_vram_bytes = capacity.min_vram_bytes
    delete capacity.min_vram_bytes
    await expect(
      verifyLocalModelManifest(envelope(oldCapacity), verifier(), {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        now: new Date('2026-08-30T12:30:00Z'),
      })
    ).rejects.toThrow('Felder')

    const nullVram = structuredClone(fixture.cases.explicit_experiment!)
    ;(
      ((nullVram.models as Array<Record<string, unknown>>)[0]!.capacity_policy ?? {}) as Record<string, unknown>
    ).min_vram_bytes = null
    await expect(
      verifyLocalModelManifest(envelope(nullVram), verifier(), {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        now: new Date('2026-08-30T12:30:00Z'),
      })
    ).rejects.toThrow('vollständigen')

    await expect(
      verifyLocalModelManifest(envelope(fixture.cases.explicit_experiment!), verifier(false), {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        now: new Date('2026-08-30T12:30:00Z'),
      })
    ).rejects.toThrow('kryptografisch')
    await expect(
      verifyLocalModelManifest(envelope(fixture.cases.explicit_experiment!), verifier(), {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083002,
        minimumPolicyVersion: 2026083001,
        now: new Date('2026-08-30T12:30:00Z'),
      })
    ).rejects.toThrow('Downgrade')
    await expect(
      verifyLocalModelManifest(envelope(fixture.cases.explicit_experiment!), verifier(), {
        trustDomain,
        acceptanceSessionId,
        acceptanceGeneration: 1,
        expectedKeyId: 'test-key',
        minimumCatalogVersion: 2026083001,
        minimumPolicyVersion: 2026083001,
        now: new Date('2026-08-30T13:00:01Z'),
      })
    ).rejects.toThrow('abgelaufen')
  })
})
