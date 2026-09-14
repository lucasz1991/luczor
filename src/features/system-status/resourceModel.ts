import { computed, type DeepReadonly } from 'vue'
import { localModelDiagnostics } from '@/services/inference/localModelDiagnostics'
import { percent, type SystemStatusState } from '@/services/systemStatusMonitor'
import type { DiskMetrics } from '@/services/systemMetrics'

export type ResourceView = 'circles' | 'history'
export type ResourceScope = 'system' | 'app' | 'model'
export type ResourceDialKey = ResourceScope | 'temperature' | 'capacity'
export type ResourceDialSeries = {
  key: ResourceDialKey
  label: string
  detail: string
  value: number | null
  colorValue?: number | null
  display?: string
  tone?: 'safe' | 'warning' | 'danger' | 'unknown'
  chart?: { path: string; last: { horizontal: number; vertical: number } | null }
}
export type ResourceMeter = {
  key: string
  label: string
  detail: string
  series: ResourceDialSeries[]
  disk?: DiskMetrics
}
export type CompactModelMetric = { label: string; value: string }

type ResourceKey = 'cpu' | 'ram' | 'gpu' | 'disk'

const scopes = [
  { key: 'system' as const, label: 'Rechner', detail: 'Gesamter Rechner' },
  { key: 'app' as const, label: 'App', detail: 'Luczor-App ohne lokalen Modellprozess' },
  { key: 'model' as const, label: 'Modell', detail: 'Verwaltetes lokales Modell' },
]

export function compactMetric(value: number | null | undefined, suffix = ''): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })}${suffix}`
    : '—'
}

export function dialDisplay(series: ResourceDialSeries): string {
  return series.value === null
    ? '—'
    : (series.display ?? `${series.value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`)
}

export function dialScope(series: ResourceDialSeries): string {
  if (series.key === 'temperature') return `temperature-${series.tone ?? 'unknown'}`
  if (series.key === 'capacity') return 'capacity'
  return series.key
}

export function diskScopes(disk: DiskMetrics): string {
  return (disk.scopes ?? ['app']).map(scope => (scope === 'model' ? 'Modell' : 'App')).join(' + ')
}

export function gibibytes(bytes: number): string {
  return (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })
}

export function useSystemResourceModel(metrics: DeepReadonly<SystemStatusState>) {
  function chart(
    key: ResourceKey,
    scope: ResourceScope,
    mount?: string
  ): { path: string; last: { horizontal: number; vertical: number } | null } {
    let path = ''
    let connected = false
    let last: { horizontal: number; vertical: number } | null = null
    metrics.history.forEach((point, index) => {
      const values = scope === 'system' ? point : scope === 'app' ? point.app : point.model
      const mountedEntry = mount
        ? Object.entries(point.disks ?? {}).find(([candidate]) => candidate === mount)
        : undefined
      const mountedDisk = mount ? mountedEntry?.[1] : point.disk
      const value =
        key === 'disk'
          ? ((scope === 'system' ? mountedDisk?.busy : scope === 'app' ? mountedDisk?.read : mountedDisk?.write) ??
            null)
          : key === 'cpu'
            ? values.cpu
            : key === 'ram'
              ? values.ram
              : values.gpu
      if (value === null) {
        connected = false
        last = null
        return
      }
      const chartX = 4 + (index / Math.max(1, metrics.history.length - 1)) * 172
      const chartY = 68 - value * 0.6
      path += `${connected ? 'L' : 'M'}${chartX.toFixed(1)},${chartY.toFixed(1)} `
      connected = true
      last = { horizontal: chartX, vertical: chartY }
    })
    return { path, last }
  }

  function resource(key: ResourceKey, label: string, detail: string, values: unknown[], mount?: string): ResourceMeter {
    return {
      key,
      label,
      detail,
      series: scopes.map((scope, index) => ({
        ...scope,
        detail:
          scope.key === 'model' && metrics.sample?.model_running === false
            ? 'Lokales Modell nicht aktiv'
            : scope.detail,
        value:
          key !== 'disk' && scope.key === 'model' && metrics.sample?.model_running === false
            ? null
            : percent(values.at(index)),
        chart: chart(key, scope.key, mount),
      })),
    }
  }

  function temperatureTone(value: number | null): ResourceDialSeries['tone'] {
    if (value === null) return 'unknown'
    if (value >= 85) return 'danger'
    if (value >= 75) return 'warning'
    return 'safe'
  }

  function temperatureSeries(label: string, value: unknown): ResourceDialSeries {
    const temperature = typeof value === 'number' && Number.isFinite(value) ? value : null
    return {
      key: 'temperature',
      label: 'Temperatur',
      detail:
        temperature === null
          ? `${label}-Temperatur: Kein unterstützter Sensoranbieter meldet einen gültigen Wert.`
          : `${label}-Temperatur${label === 'CPU' && metrics.sample?.cpu_temp_source === 'asus_atk' ? ' · ASUS-Sensor (CPU Package bevorzugt)' : ''} · ab 75 °C Hinweis, ab 85 °C kritisch`,
      value: temperature === null ? null : Math.min(100, Math.max(0, temperature)),
      display: temperature === null ? '—' : `${temperature.toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C`,
      colorValue: temperature,
      tone: temperatureTone(temperature),
    }
  }

  function storageUsed(disk: DiskMetrics): number | null {
    return disk.total_bytes > 0 ? Math.min(100, (disk.used_bytes / disk.total_bytes) * 100) : null
  }

  function diskResource(disk: DiskMetrics): ResourceMeter {
    const base = resource(
      'disk',
      disk.kind === 'ssd' ? 'SSD' : disk.kind === 'hdd' ? 'HDD' : 'Disk',
      `Volume für Luczor ${diskScopes(disk)}`,
      [disk.busy_percent, disk.read_percent, disk.write_percent],
      disk.mount
    )
    const details = [
      'Aktive Zeit dieses Luczor-Volumes',
      'Lesezeit dieses Luczor-Volumes',
      'Schreibzeit dieses Luczor-Volumes',
    ]
    return {
      ...base,
      key: `disk:${disk.mount}`,
      disk,
      series: [
        ...base.series.map((series, index) => ({ ...series, detail: details.at(index) ?? series.detail })),
        {
          key: 'capacity',
          label: 'Belegt',
          detail: `${disk.mount} · Speicherbelegung des Luczor-Volumes`,
          value: storageUsed(disk),
        },
      ],
    }
  }

  const hardware = computed<ResourceMeter[]>(() => {
    const sample = metrics.sample
    const scopedDisks = Array.isArray(sample?.disks) ? sample.disks : sample?.disk ? [sample.disk] : []
    const cpu = resource('cpu', 'CPU', 'Anteil der gesamten CPU-Kapazität', [
      sample?.cpu_percent,
      sample?.app_cpu_percent,
      sample?.model_cpu_percent,
    ])
    const gpu = resource(
      'gpu',
      'GPU',
      sample?.gpu_source === 'nvml' ? 'Geräteauslastung · NVIDIA' : 'Höchste GPU-Engine-Auslastung',
      [sample?.gpu_percent, sample?.app_gpu_percent, sample?.model_gpu_percent]
    )
    return [
      { ...cpu, series: [...cpu.series, temperatureSeries('CPU', sample?.cpu_temp_c)] },
      resource('ram', 'RAM', 'Anteil am gesamten Arbeitsspeicher', [
        sample?.ram_percent,
        sample?.app_ram_percent,
        sample?.model_ram_percent,
      ]),
      { ...gpu, series: [...gpu.series, temperatureSeries('GPU', sample?.gpu_temp_c)] },
      ...scopedDisks.map(disk => diskResource(disk as DiskMetrics)),
    ]
  })

  const modelStatus = computed(() =>
    metrics.sample?.model_running === true
      ? 'Lokales Modell aktiv'
      : metrics.sample?.model_running === false
        ? 'Kein lokales Modell aktiv'
        : 'Modellprozess nicht bestätigt'
  )

  const compactModelUsage = computed<CompactModelMetric[]>(() => {
    const sample = metrics.sample
    const run = localModelDiagnostics.state.runs[0]
    const context = run?.context
    const contextUsed =
      context && context.contextTokens > 0 ? Math.min(100, (context.inputTokens / context.contextTokens) * 100) : null
    return [
      { label: 'CPU', value: compactMetric(percent(sample?.model_cpu_percent), ' %') },
      { label: 'RAM', value: compactMetric(sample?.model_ram_used_mb, ' MiB') },
      { label: 'GPU', value: compactMetric(percent(sample?.model_gpu_percent), ' %') },
      { label: 'Kontext', value: compactMetric(contextUsed, ' %') },
      { label: 'Ausgabe', value: compactMetric(run?.runtime.outputTokensPerSecond, ' tok/s') },
      { label: 'Cache', value: compactMetric(run?.runtime.cachedTokens) },
    ]
  })

  const gpuProcessUnavailable = computed(
    () =>
      metrics.sample &&
      (percent(metrics.sample.app_gpu_percent) === null ||
        (metrics.sample.model_running === true && percent(metrics.sample.model_gpu_percent) === null))
  )

  return { compactModelUsage, gpuProcessUnavailable, hardware, modelStatus }
}
