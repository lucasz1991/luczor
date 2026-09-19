<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import {
  MEMORY_SYSTEMS,
  MODEL_NODE_ID,
  memoryEdgeControl,
  memoryEdgePath,
  memoryNodeBaseRadius,
  projectMemoryGraph,
  projectPoint,
  quadraticPoint,
  type MemoryGraph,
  type MemoryNode,
} from './graph'
import { DEFAULT_MEMORY_GRAPH_DISPLAY, type MemoryGraphDisplay } from './graphDisplay'
import { DREAM_STAGE_LABELS, type DreamRun, type DreamStage } from '@/services/memory/dreamTrace'
import {
  MEMORY_LINK_TTL_MS,
  memoryLinkNodeId,
  type MemoryLink,
  type MemoryLinkState,
  type ModelPhase,
} from '@/services/memory/modelActivity'

/**
 * "Glaskammer": the knowledge space as one SVG. Nodes are glass beads on a shallow dome, the
 * local model is the luminous core in the centre, the five system hubs orbit it, and the
 * idle-maintenance "dream" is a light that wanders through the space while it reads and writes.
 *
 * Everything is SVG + CSS: gradients and one blur filter in <defs> shared by url(), motion via
 * CSS keyframes on children with fill-box transform origins, and a single requestAnimationFrame
 * loop that only runs while something actually moves (orbit, drag momentum, zoom, light motes).
 */
export type DreamView = {
  active: boolean
  run: DreamRun | null
  reading: Set<string>
  removing: Set<string>
  conflicts: Set<string>
  touched: Set<string>
}

const props = withDefaults(
  defineProps<{
    graph: MemoryGraph
    selected: string
    dream?: DreamView | null
    display?: MemoryGraphDisplay
    /** Emergency offload is active: the pass runs slowly on the page file. */
    offloading?: boolean
    /** What the local model is doing right now; drives the pulse of the core. */
    phase?: ModelPhase
    /** Live model ↔ memory links: recalled, included, omitted, written, updated, removed. */
    links?: MemoryLink[]
    /** Renders as the app backdrop: no controls, no legend, no pointer handling, minimal motion. */
    ambient?: boolean
  }>(),
  {
    dream: null,
    display: () => ({ ...DEFAULT_MEMORY_GRAPH_DISPLAY }),
    offloading: false,
    phase: 'idle',
    links: () => [],
    ambient: false,
  }
)
const emit = defineEmits<{ select: [id: string] }>()

type Band = 'near' | 'mid' | 'far'
type Point = MemoryNode & {
  left: number
  top: number
  depth: number
  radius: number
  scale: number
  hub: boolean
  model: boolean
  radiusBase: number
  radiusEff: number
  /** 1 / scale: pills and flags sit inside the scaled node group but must keep their size. */
  unscale: number
  depthT: number
  dp: number
  band: Band
}
type Pill = {
  left: number
  top: number
  width: number
  height: number
  fontSize: number
  text: string
  count: string | null
  hub: boolean
  model: boolean
  textX: number
  textY: number
  dotX: number
}
type Flag = { text: string; cls: string; left: number; top: number }
/** One circle of a bead, drawn at (cx, cy) with radius r in bead units; the body is always one of them. */
type Layer = { key: string; cls: string; radius: number; cx?: number; cy?: number }
type Entry = {
  point: Point
  hit: number
  layers: Layer[]
  cls: Record<string, boolean>
  style: Record<string, number | string>
  pill: Pill | null
  flag: Flag | null
}
type StoredEdge = { key: string; path: string; band: Band; kind: string }
type SpecialEdge = { key: string; path: string; cls: string; kind: string }
type Mist = { system: string; hub: Point; rx: number; ry: number }
type LinkEdge = { key: string; state: MemoryLinkState; path: string; opacity: number; written: boolean }
type MoteSlot = { key: number; nodeId: string; state: MemoryLinkState; link: MemoryLink; offset: number }

const HOME = { yaw: 0.12, pitch: -0.12, zoom: 1 }
const ZOOM_MIN = 0.45
const ZOOM_MAX = 2.4
const ZOOM_STEP = 0.15
const PITCH_LIMIT = 1.2
const MAX_THREADS = 12
const MAX_FLOW = 12
const MAX_LINK_MOTES = 24
const FLOOR_STEPS = 48
const STAGE_PROGRESS = new Map<DreamStage, number>([
  ['scanning', 8],
  ['selecting', 20],
  ['preparing', 32],
  ['generating', 55],
  ['verifying', 78],
  ['committing', 92],
  ['done', 100],
])
const STAGE_WORD = new Map<DreamStage, string>([
  ['scanning', 'SICHTEN'],
  ['selecting', 'SICHTEN'],
  ['preparing', 'SICHTEN'],
  ['generating', 'ERZEUGEN'],
  ['verifying', 'PRÜFEN'],
  ['committing', 'ÜBERNEHMEN'],
  ['done', 'ÜBERNEHMEN'],
  ['failed', 'VERWORFEN'],
  ['interrupted', 'UNTERBROCHEN'],
])
const STAGES_WITH_THREADS = new Set<DreamStage>(['generating', 'verifying'])
const STAGES_AT_START = new Set<DreamStage>(['scanning', 'selecting', 'preparing'])
const LINK_TOWARD_CORE = new Set<MemoryLinkState>(['recalled', 'included'])
const LINK_WITH_MOTES = new Set<MemoryLinkState>(['recalled', 'included', 'written', 'updated'])
const SYSTEM_INDEX = new Map(MEMORY_SYSTEMS.map((system, index) => [system, index]))

const uid = useId()
const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const yaw = ref(HOME.yaw)
const pitch = ref(HOME.pitch)
const zoom = ref(HOME.zoom)
/** Gentle breathing of the whole space while dreaming; added to pitch in the projection only. */
const sway = ref(0)
const hovered = ref<string | null>(null)
const dragging = ref(false)
/** Coarse clock (≈1 s) for link ages; the frame loop advances it while it runs. */
const clock = ref(Date.now())
const threadRotation = ref(0)
const moteRotation = ref(0)
const fontVersion = ref(0)
const svgEl = ref<SVGSVGElement | null>(null)
const dreamMoteLayer = ref<SVGGElement | null>(null)
const linkMoteLayer = ref<SVGGElement | null>(null)

/* ------------------------------------------------------------------ paint servers */
const paints = computed(() => {
  const url = (name: string) => `url(#${uid}-${name})`
  return {
    '--mg-u-glass': url('glass'),
    '--mg-u-glass-lit': url('glass-lit'),
    '--mg-u-glass-born': url('glass-born'),
    '--mg-u-glass-conflict': url('glass-conflict'),
    '--mg-u-rim': url('rim'),
    '--mg-u-ring': url('ring'),
    '--mg-u-glow': url('glow'),
    '--mg-u-glow-green': url('glow-green'),
    '--mg-u-glow-orange': url('glow-orange'),
    '--mg-u-mist': url('mist'),
    '--mg-u-mist-lit': url('mist-lit'),
    '--mg-u-floor': url('floor'),
    '--mg-u-aura': url('aura'),
    '--mg-u-core': url('core'),
    '--mg-u-blur': url('blur'),
    '--mg-u-blur-core': url('blur-core'),
  }
})

/* ------------------------------------------------------------------ dream state */
const dreamVisible = computed(() => !!props.dream?.active && props.display.dreamAnimation)
const animatedDream = computed(() => dreamVisible.value && !reducedMotion)
const lastStep = computed(() => props.dream?.run?.steps.at(-1))
const stage = computed<DreamStage | undefined>(() => lastStep.value?.stage)
const dreamStage = computed(() => (lastStep.value ? DREAM_STAGE_LABELS[lastStep.value.stage] : ''))
const stageWord = computed(() => (stage.value ? (STAGE_WORD.get(stage.value) ?? '') : ''))
/** Failed/interrupted runs keep the progress of the last stage that had one. */
const progress = computed(() => {
  const steps = props.dream?.run?.steps ?? []
  for (let index = steps.length - 1; index >= 0; index--) {
    const value = STAGE_PROGRESS.get(steps.at(index)?.stage ?? 'scanning')
    if (value !== undefined) return value
  }
  return 0
})
const runOutcome = computed(() => props.dream?.run?.outcome)
const taskHub = computed(() => {
  const task = props.dream?.run?.task
  return task === 'repository' ? 'system:2' : task === 'context' ? 'system:4' : 'system:0'
})
const spinning = computed(() => !reducedMotion && (props.display.autoRotate || animatedDream.value))

/* ------------------------------------------------------------------ graph derived (changes rarely) */
const nodeIds = computed(() => new Set(props.graph.nodes.map(node => node.id)))
const focusId = computed(() => (props.ambient ? '' : props.selected))
const hasSelection = computed(() => !!focusId.value && nodeIds.value.has(focusId.value))
const adjacent = computed(() => {
  const set = new Set<string>()
  const id = focusId.value
  if (!id) return set
  for (const edge of props.graph.edges) {
    if (edge.from === id) set.add(edge.to)
    else if (edge.to === id) set.add(edge.from)
  }
  return set
})
/* Hovering a node lifts it and its neighbours; everything else recedes softly. */
const hoverId = computed(() => (props.ambient || dragging.value ? '' : (hovered.value ?? '')))
const hoverAdjacent = computed(() => {
  const set = new Set<string>()
  const id = hoverId.value
  if (!id) return set
  for (const edge of props.graph.edges) {
    if (edge.from === id) set.add(edge.to)
    else if (edge.to === id) set.add(edge.from)
  }
  return set
})
/* Deterministic star field and orbit rings give the knowledge space depth; positions never change. */
type Star = { x: number; y: number; r: number; delay: number; duration: number; far: boolean }
const stars: readonly Star[] = (() => {
  let seed = 0x9e3779b1
  const next = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x7fffffff) >>> 0
    return (seed >>> 8) / 0x01000000
  }
  return Array.from({ length: 72 }, (_, index) => ({
    x: Math.round(next() * 800 * 10) / 10,
    y: Math.round(next() * 500 * 10) / 10,
    r: Math.round((0.4 + next() * 1.1) * 100) / 100,
    delay: Math.round(next() * 9000),
    duration: 4200 + Math.round(next() * 6000),
    far: index % 3 !== 0,
  }))
})()
const ORBIT_RINGS = [
  { rx: 150, ry: 46, duration: 52, reverse: false },
  { rx: 235, ry: 74, duration: 78, reverse: true },
  { rx: 320, ry: 102, duration: 110, reverse: false },
] as const
/* Nodes play their entrance whenever a different graph arrives, never on every rotation frame. */
const sceneEntrance = ref(0)
watch(
  () => [props.graph.nodes.length, props.graph.nodes[0]?.id ?? '', props.graph.edges.length] as const,
  () => {
    sceneEntrance.value++
  }
)
const systemCount = computed(() => {
  const counts = new Map<string, number>()
  for (const node of props.graph.nodes) {
    if (node.kind === 'System' || node.kind === 'Modell') continue
    counts.set(node.system, (counts.get(node.system) ?? 0) + 1)
  }
  return counts
})
const linkByNode = computed(() => {
  const map = new Map<string, MemoryLink>()
  for (const link of props.links) {
    const id = memoryLinkNodeId(link)
    if (nodeIds.value.has(id)) map.set(id, link)
  }
  return map
})
const readingSystems = computed(() => {
  const systems = new Set<string>()
  const reading = props.dream?.reading
  if (!reading?.size) return systems
  for (const node of props.graph.nodes) if (reading.has(node.id)) systems.add(node.system)
  return systems
})

/* ------------------------------------------------------------------ label measurement */
const labelWidth = new Map<string, number>()
let measure: CanvasRenderingContext2D | null = null
let fontFamily = 'system-ui, sans-serif'
let monoFamily = 'ui-monospace, monospace'
function textWidth(text: string, size: number, weight: number, mono = false): number {
  const key = `${weight}|${size}|${mono ? 'm' : 's'}|${text}`
  const cached = labelWidth.get(key)
  if (cached !== undefined) return cached
  let width = text.length * size * 0.56
  if (measure) {
    try {
      measure.font = `${weight} ${size}px ${mono ? monoFamily : fontFamily}`
      width = measure.measureText(text).width
    } catch {
      /* jsdom or a canvas-less host: the estimate above stands */
    }
  }
  if (labelWidth.size > 4000) labelWidth.clear()
  labelWidth.set(key, width)
  return width
}
onMounted(() => {
  try {
    const svg = svgEl.value
    if (svg) {
      const style = getComputedStyle(svg)
      fontFamily = style.fontFamily || fontFamily
      monoFamily = style.getPropertyValue('--font-mono').trim() || monoFamily
    }
    measure = document.createElement('canvas').getContext('2d')
    labelWidth.clear()
    fontVersion.value++
    void document.fonts?.ready.then(() => {
      labelWidth.clear()
      fontVersion.value++
    })
  } catch {
    measure = null
  }
})

/* ------------------------------------------------------------------ frame scene (one O(n) pass) */
function floorPath(yawValue: number, pitchValue: number, zoomValue: number): string {
  const parts: string[] = []
  for (let index = 0; index < FLOOR_STEPS; index++) {
    const angle = (index / FLOOR_STEPS) * Math.PI * 2
    const point = projectPoint(Math.cos(angle) * 300, 175, Math.sin(angle) * 300, yawValue, pitchValue, zoomValue)
    if (point.depth <= -600) continue
    parts.push(`${parts.length ? 'L' : 'M'}${point.left.toFixed(1)} ${point.top.toFixed(1)}`)
  }
  return parts.length > 2 ? `${parts.join(' ')} Z` : ''
}
const scene = computed(() => {
  const display = props.display
  const zoomValue = zoom.value
  const projected = projectMemoryGraph(props.graph.nodes, yaw.value, pitch.value + sway.value, zoomValue)
  const points: Point[] = projected.map(raw => {
    const scale = (650 / (650 + raw.depth)) * zoomValue
    const hub = raw.kind === 'System'
    const model = raw.kind === 'Modell'
    const radiusBase = memoryNodeBaseRadius(raw) * display.nodeScale
    const depthT = clamp((raw.depth + 260) / 520, 0, 1)
    const dp = model || !display.depthFade ? 1 : Math.round((0.3 + 0.7 * (1 - depthT) ** 1.35) * 10) / 10
    const band: Band = !display.depthFade ? 'mid' : depthT < 0.33 ? 'near' : depthT > 0.66 ? 'far' : 'mid'
    return {
      ...raw,
      scale,
      hub,
      model,
      radiusBase,
      radiusEff: radiusBase * scale,
      unscale: 1 / scale,
      depthT,
      dp,
      band,
    }
  })
  const byId = new Map(points.map(point => [point.id, point]))
  // Mist blobs: one per system hub, sized by the spread of its members.
  const spread = new Map<string, { hub: Point; dx: number; dy: number }>()
  for (const system of MEMORY_SYSTEMS) {
    const hub = byId.get(`system:${SYSTEM_INDEX.get(system) ?? 0}`)
    if (hub) spread.set(system, { hub, dx: 0, dy: 0 })
  }
  for (const point of points) {
    if (point.hub || point.model) continue
    const blob = spread.get(point.system)
    if (!blob) continue
    blob.dx = Math.max(blob.dx, Math.abs(point.left - blob.hub.left))
    blob.dy = Math.max(blob.dy, Math.abs(point.top - blob.hub.top))
  }
  const mist: Mist[] = []
  for (const [system, blob] of spread)
    mist.push({ system, hub: blob.hub, rx: Math.max(60, 1.15 * blob.dx), ry: Math.max(40, 1.15 * blob.dy) })
  // Edges: grouping in three depth bundles, stored relations as single paths, special edges on top.
  const bundles = new Map<Band, string[]>([
    ['near', []],
    ['mid', []],
    ['far', []],
  ])
  const spokes: string[] = []
  const stored: StoredEdge[] = []
  const special: SpecialEdge[] = []
  const selectedBundle: string[] = []
  const flows: string[] = []
  const selectedId = focusId.value
  const edgeMode = display.edges
  let selectedCount = 0
  for (const edge of props.graph.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const key = `${edge.from}>${edge.to}`
    // Transient edges first: a new or replaced memory must animate even when its hub is selected.
    if (from.state === 'born' || to.state === 'born') {
      const start = to.state === 'born' ? from : to
      const end = to.state === 'born' ? to : from
      special.push({ key, path: memoryEdgePath(start, end), cls: 'edge--born', kind: edge.kind })
      continue
    }
    if (from.state === 'removed' || to.state === 'removed') {
      special.push({ key, path: memoryEdgePath(from, to), cls: 'edge--ghost', kind: edge.kind })
      continue
    }
    if (selectedId && (edge.from === selectedId || edge.to === selectedId)) {
      const start = edge.from === selectedId ? from : to
      const end = edge.from === selectedId ? to : from
      const path = memoryEdgePath(start, end)
      if (selectedCount++ < MAX_FLOW) flows.push(path)
      // Membership spokes of a selected hub share one path; stored relations keep their tooltip.
      if (edge.grouping) selectedBundle.push(path)
      else special.push({ key, path, cls: 'edge--selected', kind: edge.kind })
      continue
    }
    if (edgeMode === 'none') continue
    if (edge.grouping && from.model) {
      spokes.push(memoryEdgePath(from, to))
      continue
    }
    if (edge.grouping) {
      if (edgeMode !== 'all') continue
      const mean = (from.depthT + to.depthT) / 2
      const band: Band = !display.depthFade ? 'mid' : mean < 0.33 ? 'near' : mean > 0.66 ? 'far' : 'mid'
      bundles.get(band)?.push(memoryEdgePath(from, to))
      continue
    }
    const mean = (from.depthT + to.depthT) / 2
    const band: Band = !display.depthFade ? 'mid' : mean < 0.33 ? 'near' : mean > 0.66 ? 'far' : 'mid'
    stored.push({ key, path: memoryEdgePath(from, to), band, kind: edge.kind })
  }
  return {
    points,
    byId,
    mist,
    // A hub with dozens of members would drown everything else in spokes; soften them.
    dense: selectedCount > 16,
    selectedBundle: selectedBundle.join(' '),
    flows,
    floorD: floorPath(yaw.value, pitch.value + sway.value, zoomValue),
    bundleNear: bundles.get('near')?.join(' ') ?? '',
    bundleMid: bundles.get('mid')?.join(' ') ?? '',
    bundleFar: bundles.get('far')?.join(' ') ?? '',
    spokesD: spokes.join(' '),
    stored,
    special,
  }
})

/* ------------------------------------------------------------------ node entries */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
/** Labels stay small in the knowledge space so the structure, not the text, dominates. */
const LABEL_SCALE = 0.55
function showPill(point: Point): boolean {
  // Behind a chat the graph is pure ambience: no labels at all, not even hubs or the model.
  if (props.ambient) return false
  if (point.model) return true
  if (point.id === props.selected) return true
  const labels = props.display.labels
  if (labels === 'all') return point.hub || point.depthT <= 0.72
  if (labels === 'hubs') return point.hub
  return false
}
function pillFor(point: Point): Pill | null {
  if (!showPill(point)) return null
  void fontVersion.value
  const hub = point.hub
  const major = hub || point.model
  const size = (major ? 11 : 10.5) * LABEL_SCALE
  const weight = major ? 600 : 500
  const raw = truncate(point.label, major ? 48 : 30)
  const text = hub ? raw.toUpperCase() : raw
  const spacing = hub ? 0.08 * size * text.length : 0
  const count = hub ? `· ${systemCount.value.get(point.system) ?? 0}` : null
  const countWidth = count ? textWidth(count, 10 * LABEL_SCALE, 500, true) + 4 : 0
  const padding = (major ? 10 : 8) * LABEL_SCALE
  const dot = hub ? 12 * LABEL_SCALE : 0
  const width = Math.round(textWidth(text, size, weight) + spacing + 2 * padding + dot + countWidth)
  const height = Math.round((major ? 22 : 18) * LABEL_SCALE)
  if (point.model) {
    return {
      left: -width / 2,
      top: point.radiusEff + 6 + height,
      width,
      height,
      fontSize: size,
      text,
      count,
      hub,
      model: true,
      textX: padding,
      textY: -height / 2,
      dotX: 0,
    }
  }
  let left = point.radiusEff + 6
  if (point.left + left + width > 792) left = -point.radiusEff - 6 - width
  return {
    left,
    top: -point.radiusEff - 4,
    width,
    height,
    fontSize: size,
    text,
    count,
    hub,
    model: false,
    textX: padding + dot,
    textY: -height / 2,
    dotX: padding + 3,
  }
}
const waveFactor = shallowRef(new Map<string, number>())
function buildEntry(point: Point): Entry {
  const dream = props.dream
  const link = linkByNode.value.get(point.id)
  const state = link?.state
  const linkAt = link?.at ?? 0
  const selected = point.id === props.selected
  const showSelection = selected && !props.ambient
  const reading = !!dream?.reading.has(point.id)
  const touched = !!dream?.touched.has(point.id)
  const conflict = !!dream?.conflicts.has(point.id)
  const born = point.state === 'born'
  const cls = {
    selected,
    'is-hover': point.id === hoverId.value,
    'is-hover-near': hoverAdjacent.value.has(point.id),
    hub: point.hub,
    model: point.model,
    'is-reading': reading,
    'is-removing': !!dream?.removing.has(point.id) || point.state === 'removed',
    'is-conflict': conflict,
    'is-touched': touched,
    'is-born': born,
    'is-ghost': point.state === 'removed',
    'is-adjacent': adjacent.value.has(point.id),
    'is-near': point.band === 'near',
    'is-far': point.band === 'far',
    'is-recalled': state === 'recalled',
    'is-included': state === 'included',
    'is-omitted': state === 'omitted',
    'is-written': state === 'written',
    'is-updated': state === 'updated',
    'is-deleted': state === 'removed',
  }
  const style: Record<string, number | string> = { '--dp': point.dp }
  if (!props.ambient) {
    // Stagger the entrance by depth so the space builds from the back to the front.
    style['--enter-delay'] = `${Math.round(120 + (1 - point.depthT) * 420)}ms`
  }
  const wave = waveFactor.value.get(point.id)
  if (wave !== undefined) style['--wave-f'] = wave
  const pill = pillFor(point)
  let flag: Flag | null = null
  if (born || conflict) {
    flag = {
      text: born ? 'NEU' : '!',
      cls: born ? 'flag--born' : 'flag--conflict',
      left: point.radiusEff + 3,
      top: pill ? point.radiusEff + 11 : -point.radiusEff - 3,
    }
  }
  // Only the circles a node really needs become elements; a plain bead is just hit + body.
  const rb = point.radiusBase
  const layers: Layer[] = []
  if (point.model) {
    layers.push(
      { key: 'halo', cls: 'core-halo', radius: rb * 2.3 },
      { key: 'ring', cls: 'core-ring', radius: rb + 9 },
      { key: 'body', cls: 'core-body', radius: rb },
      { key: 'rim', cls: 'core-rim', radius: rb },
      { key: 'spark', cls: 'core-spark', radius: rb * 0.42, cx: -rb * 0.3, cy: -rb * 0.32 }
    )
    if (showSelection)
      layers.push(
        { key: 'sel', cls: 'ring', radius: rb + 14 },
        { key: `pick:${props.selected}`, cls: 'pick', radius: rb + 10 }
      )
    return { point, hit: rb + 14, layers, cls, style, pill, flag }
  }
  if (showSelection || born) layers.push({ key: 'glow', cls: 'glow', radius: 3 * rb + 8 })
  if (point.hub) layers.push({ key: 'shell', cls: 'shell', radius: rb + 4 })
  if (state === 'written' || state === 'updated') layers.push({ key: `flash:${linkAt}`, cls: 'flash', radius: rb + 5 })
  layers.push({ key: 'body', cls: 'body', radius: rb })
  if (reading || touched) layers.push({ key: 'lit', cls: 'lit', radius: rb })
  if (reading) layers.push({ key: 'halo', cls: 'halo', radius: rb + 6 })
  else if (touched) layers.push({ key: 'warm', cls: 'warm', radius: rb + 3 })
  if (conflict)
    layers.push(
      { key: 'warn-in', cls: 'warn warn--in', radius: rb + 3 },
      { key: 'warn-out', cls: 'warn warn--out', radius: rb + 6 }
    )
  if (born) layers.push({ key: 'ripple', cls: 'ripple', radius: rb + 4 })
  if (state && state !== 'removed' && state !== 'omitted')
    layers.push({ key: 'link', cls: 'link-ring', radius: rb + 4 })
  if (state === 'written') layers.push({ key: `burst:${linkAt}`, cls: 'burst', radius: rb + 3 })
  if (state === 'updated')
    layers.push(
      { key: `pulse-a:${linkAt}`, cls: 'pulse', radius: rb + 3 },
      { key: `pulse-b:${linkAt}`, cls: 'pulse pulse--b', radius: rb + 3 }
    )
  if (state === 'removed') layers.push({ key: 'remnant', cls: 'remnant', radius: rb + 2 })
  if (showSelection)
    layers.push(
      { key: 'sel', cls: 'ring', radius: rb + 5 },
      { key: `pick:${props.selected}`, cls: 'pick', radius: rb + 2 }
    )
  return { point, hit: Math.max(16, rb + 6), layers, cls, style, pill, flag }
}
const entries = computed(() => {
  const regular: Entry[] = []
  const transient: Entry[] = []
  for (const point of scene.value.points) (point.state ? transient : regular).push(buildEntry(point))
  // Born/ghost nodes keep a stable order in their own layer so one-shot animations never restart.
  transient.sort((left, right) => (left.point.id < right.point.id ? -1 : left.point.id > right.point.id ? 1 : 0))
  return { regular, transient }
})
const hoverPill = computed(() => {
  const id = hovered.value
  if (!id || dragging.value || props.ambient) return null
  const point = scene.value.byId.get(id)
  if (!point || showPill(point)) return null
  void fontVersion.value
  const text = truncate(`${point.label} · ${point.kind}`, 40)
  const width = Math.round(textWidth(text, 10.5, 500) + 16)
  let left = point.left + point.radiusEff + 10
  if (left + width > 792) left = point.left - point.radiusEff - 10 - width
  return { left, top: point.top - point.radiusEff - 6, width, height: 18, text }
})
const mistBlobs = computed(() =>
  scene.value.mist.map(blob => ({
    ...blob,
    lit:
      readingSystems.value.has(blob.system) ||
      ((stage.value === 'selecting' || stage.value === 'preparing') &&
        blob.hub.id === taskHub.value &&
        dreamVisible.value),
  }))
)

/* ------------------------------------------------------------------ model ↔ memory links */
function linkLife(link: MemoryLink, now: number): number {
  const ttl = MEMORY_LINK_TTL_MS[link.state]
  const age = now - link.at
  if (age <= ttl * 0.35) return 1
  return clamp(1 - (age - ttl * 0.35) / (ttl * 0.65), 0, 1)
}
const linkEdges = computed<LinkEdge[]>(() => {
  const { byId } = scene.value
  const core = byId.get(MODEL_NODE_ID)
  if (!core) return []
  const now = clock.value
  const edges: LinkEdge[] = []
  for (const link of props.links) {
    const node = byId.get(memoryLinkNodeId(link))
    if (!node) continue
    edges.push({
      key: `${node.id}:${link.state}:${link.at}`,
      state: link.state,
      path: memoryEdgePath(core, node, 26),
      opacity: Math.round(linkLife(link, now) * 100) / 100,
      written: link.state === 'written',
    })
  }
  return edges
})
/** Up to 24 light motes distributed round-robin over the links that carry traffic. */
const linkMoteSlots = computed<MoteSlot[]>(() => {
  if (reducedMotion || !nodeIds.value.has(MODEL_NODE_ID)) return []
  const candidates = props.links.filter(
    link => LINK_WITH_MOTES.has(link.state) && nodeIds.value.has(memoryLinkNodeId(link))
  )
  const total = candidates.length
  if (!total) return []
  const windowSize = Math.min(total, MAX_LINK_MOTES)
  const start = total > MAX_LINK_MOTES ? moteRotation.value % total : 0
  const perLink = clamp(Math.floor(MAX_LINK_MOTES / windowSize), 1, 3)
  const slots: MoteSlot[] = []
  for (let index = 0; index < windowSize; index++) {
    const link = candidates.at((start + index) % total)
    if (!link) continue
    for (let mote = 0; mote < perLink; mote++)
      slots.push({
        key: slots.length,
        nodeId: memoryLinkNodeId(link),
        state: link.state,
        link,
        offset: mote / perLink + index * 0.07,
      })
  }
  return slots
})

/* ------------------------------------------------------------------ dream light */
const orbPos = ref({ left: 400, top: 250 })
/** Smoothed orb position owned by the frame loop; orbPos publishes it at the render cadence. */
const orb = { left: 400, top: 250 }
const orbTarget = computed(() => {
  const { byId } = scene.value
  const current = stage.value
  const reading = props.dream?.reading
  let anchors: Point[] = []
  if (current && !STAGES_AT_START.has(current) && reading?.size) {
    for (const id of reading) {
      const point = byId.get(id)
      if (point) anchors.push(point)
    }
  }
  if (!anchors.length) {
    const hub = byId.get(current === 'committing' || current === 'done' ? taskHub.value : 'system:0')
    if (hub) anchors = [hub]
  }
  if (!anchors.length) return { left: 400, top: 250 }
  let left = 0
  let top = 0
  let lift = 0
  for (const point of anchors) {
    left += point.left
    top += point.top
    lift = Math.max(lift, point.radiusEff)
  }
  return { left: left / anchors.length, top: top / anchors.length - (lift + 22) }
})
const orbShown = computed(() => (animatedDream.value ? orbPos.value : orbTarget.value))
const readingWindow = computed(() => {
  if (!dreamVisible.value || !stage.value || !STAGES_WITH_THREADS.has(stage.value)) return []
  const ids = Array.from(props.dream?.reading ?? []).sort()
  if (ids.length <= MAX_THREADS) return ids
  const start = threadRotation.value % ids.length
  const window: string[] = []
  for (let index = 0; index < MAX_THREADS; index++) window.push(ids.at((start + index) % ids.length) ?? '')
  return window
})
const dreamThreads = computed(() => {
  const { byId } = scene.value
  const anchor = orbShown.value
  const threads: Array<{ id: string; path: string; point: Point }> = []
  for (const id of readingWindow.value) {
    const point = byId.get(id)
    if (point) threads.push({ id, path: memoryEdgePath(anchor, point), point })
  }
  return threads
})
const wave = ref<{ key: string; hubId: string } | null>(null)
const waveHub = computed(() => (wave.value ? scene.value.byId.get(wave.value.hubId) : undefined))
// The wave may start on the final `done` step, when the run is already inactive; it must not depend on dreamVisible.
watch(stage, (next, previous) => {
  const run = props.dream?.run
  if (!run || reducedMotion || !props.display.dreamAnimation || !next) return
  if (next === 'committing' || (next === 'done' && previous !== 'committing')) {
    const hubId = taskHub.value
    const hub = scene.value.byId.get(hubId)
    const factors = new Map<string, number>()
    if (hub && props.dream?.touched.size) {
      for (const id of props.dream.touched) {
        const point = scene.value.byId.get(id)
        if (point) factors.set(id, clamp(Math.hypot(point.left - hub.left, point.top - hub.top) / 276, 0, 1))
      }
    }
    waveFactor.value = factors
    wave.value = { key: `${run.id}:${next}`, hubId }
  }
})
function endWave() {
  wave.value = null
  waveFactor.value = new Map()
}
watch(dreamVisible, visible => {
  if (!visible) return
  // The light appears where it is needed instead of travelling from its last resting place.
  orb.left = orbTarget.value.left
  orb.top = orbTarget.value.top
  orbPos.value = { left: orb.left, top: orb.top }
})

/* ------------------------------------------------------------------ interaction */
type Drag = {
  id: number
  left: number
  top: number
  distance: number
  nodeId: string | null
  lastAt: number
  vx: number
  vy: number
}
let drag: Drag | undefined
let pendingMove: PointerEvent | null = null
const momentum = { vx: 0, vy: 0 }
let zoomTarget = HOME.zoom
let viewTarget: { yaw: number; pitch: number } | null = null

function nodeIdOf(target: EventTarget | null): string | null {
  return (target as Element | null)?.closest?.('[data-node]')?.getAttribute('data-node') ?? null
}
function down(event: PointerEvent) {
  if (event.button !== 0) return
  drag = {
    id: event.pointerId,
    left: event.clientX,
    top: event.clientY,
    distance: 0,
    nodeId: nodeIdOf(event.target),
    lastAt: performance.now(),
    vx: 0,
    vy: 0,
  }
  momentum.vx = 0
  momentum.vy = 0
  viewTarget = null
  dragging.value = true
  hovered.value = null
  try {
    ;(event.currentTarget as SVGElement).setPointerCapture(event.pointerId)
  } catch {
    /* capture is a nicety; dragging works without it */
  }
}
function move(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  pendingMove = event
  ensureLoop()
}
/** Applies the last pointer position once per frame (1000 Hz mice must not project several times per frame). */
function applyMove(now: number) {
  const event = pendingMove
  pendingMove = null
  if (!event || !drag) return
  const dx = event.clientX - drag.left
  const dy = event.clientY - drag.top
  if (!dx && !dy) return
  drag.distance += Math.abs(dx) + Math.abs(dy)
  yaw.value += dx * 0.007
  pitch.value = clamp(pitch.value + dy * 0.007, -PITCH_LIMIT, PITCH_LIMIT)
  const dt = Math.max(1, now - drag.lastAt)
  drag.vx = drag.vx * 0.4 + ((dx * 0.007) / dt) * 0.6
  drag.vy = drag.vy * 0.4 + ((dy * 0.007) / dt) * 0.6
  drag.lastAt = now
  drag.left = event.clientX
  drag.top = event.clientY
}
function up(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  applyMove(performance.now())
  const current = drag
  drag = undefined
  dragging.value = false
  if (current.distance > 5) {
    if (!reducedMotion && performance.now() - current.lastAt < 80) {
      momentum.vx = clamp(current.vx, -0.02, 0.02)
      momentum.vy = clamp(current.vy, -0.02, 0.02)
      ensureLoop()
    }
    return
  }
  if (current.nodeId) emit('select', current.nodeId)
}
function cancel() {
  drag = undefined
  pendingMove = null
  dragging.value = false
}
function over(event: PointerEvent) {
  if (drag) return
  hovered.value = nodeIdOf(event.target)
}
function leave() {
  hovered.value = null
}
function wheel(event: WheelEvent) {
  event.preventDefault()
  const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode === 2 ? 0.5 : 0.0016))
  zoomTarget = clamp(zoomTarget * factor, ZOOM_MIN, ZOOM_MAX)
  if (reducedMotion) zoom.value = zoomTarget
  else ensureLoop()
}
function key(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'Home'].includes(event.key)) return
  event.preventDefault()
  viewTarget = null
  if (event.key === 'ArrowLeft') yaw.value -= 0.15
  if (event.key === 'ArrowRight') yaw.value += 0.15
  if (event.key === 'ArrowUp') pitch.value = Math.max(-PITCH_LIMIT, pitch.value - 0.1)
  if (event.key === 'ArrowDown') pitch.value = Math.min(PITCH_LIMIT, pitch.value + 0.1)
  if (event.key === '+') setZoom(ZOOM_STEP)
  if (event.key === '-') setZoom(-ZOOM_STEP)
  if (event.key === 'Home') reset()
}
function reset() {
  momentum.vx = 0
  momentum.vy = 0
  zoomTarget = HOME.zoom
  const turns = Math.round((yaw.value - HOME.yaw) / (Math.PI * 2))
  if (reducedMotion) {
    yaw.value = HOME.yaw
    pitch.value = HOME.pitch
    zoom.value = HOME.zoom
    return
  }
  viewTarget = { yaw: HOME.yaw + turns * Math.PI * 2, pitch: HOME.pitch }
  ensureLoop()
}
function setZoom(delta: number) {
  zoomTarget = clamp(zoomTarget + delta, ZOOM_MIN, ZOOM_MAX)
  if (reducedMotion) zoom.value = zoomTarget
  else ensureLoop()
}
const pointerHandlers = computed(() =>
  props.ambient
    ? {}
    : {
        pointerdown: down,
        pointermove: move,
        pointerup: up,
        pointercancel: cancel,
        lostpointercapture: cancel,
        pointerover: over,
        pointerleave: leave,
        wheel,
      }
)

/* ------------------------------------------------------------------ frame loop */
let frame: number | undefined
let lastFrame = 0
let lastRender = 0
let yawAccum = 0
let clockAt = 0
const easeInOut = (phase: number) => (phase < 0.5 ? 2 * phase * phase : 1 - (-2 * phase + 2) ** 2 / 2)

function needsFrame(): boolean {
  return (
    pendingMove !== null ||
    momentum.vx !== 0 ||
    momentum.vy !== 0 ||
    viewTarget !== null ||
    zoom.value !== zoomTarget ||
    spinning.value ||
    animatedDream.value ||
    linkMoteSlots.value.length > 0
  )
}
function ensureLoop() {
  if (frame !== undefined || typeof requestAnimationFrame !== 'function' || !needsFrame()) return
  lastFrame = 0
  frame = requestAnimationFrame(tick)
}
function moveMotes(
  layer: SVGGElement | null,
  count: number,
  place: (index: number) => { left: number; top: number; opacity: number } | null
) {
  if (!layer) return
  for (let index = 0; index < count; index++) {
    const element = layer.children.item(index)
    if (!element) break
    const spot = place(index)
    if (!spot) {
      element.setAttribute('opacity', '0')
      continue
    }
    element.setAttribute('transform', `translate(${spot.left.toFixed(1)} ${spot.top.toFixed(1)})`)
    element.setAttribute('opacity', spot.opacity.toFixed(2))
  }
}
function tick(now: number) {
  frame = undefined
  const dt = lastFrame ? Math.min(64, now - lastFrame) : 16
  lastFrame = now
  applyMove(now)
  // Drag momentum with exponential damping.
  if (!drag && (momentum.vx || momentum.vy)) {
    yaw.value += momentum.vx * dt
    pitch.value = clamp(pitch.value + momentum.vy * dt, -PITCH_LIMIT, PITCH_LIMIT)
    const decay = Math.exp(-dt / 260)
    momentum.vx *= decay
    momentum.vy *= decay
    if (Math.abs(momentum.vx) + Math.abs(momentum.vy) < 0.00002) {
      momentum.vx = 0
      momentum.vy = 0
    }
  }
  // Zoom eases towards its target; the reset tween brings yaw/pitch home.
  if (zoom.value !== zoomTarget) {
    const next = zoom.value + (zoomTarget - zoom.value) * (1 - Math.exp(-dt / 110))
    zoom.value = Math.abs(zoomTarget - next) < 0.0005 ? zoomTarget : next
  }
  if (viewTarget && !drag) {
    const blend = 1 - Math.exp(-dt / 140)
    yaw.value += (viewTarget.yaw - yaw.value) * blend
    pitch.value += (viewTarget.pitch - pitch.value) * blend
    if (Math.abs(viewTarget.yaw - yaw.value) < 0.002 && Math.abs(viewTarget.pitch - pitch.value) < 0.002) {
      yaw.value = viewTarget.yaw
      pitch.value = viewTarget.pitch
      viewTarget = null
    }
  }
  // Auto orbit, throttled to 30 fps while dreaming (20 fps under emergency offload).
  const dreaming = animatedDream.value
  const interval = dreaming ? (props.offloading ? 50 : 33) : 0
  const render = now - lastRender >= interval
  if (spinning.value && !drag && !viewTarget) yawAccum += (dreaming ? 0.00012 : 0.00008) * dt
  if (render) {
    lastRender = now
    if (yawAccum) {
      yaw.value += yawAccum
      yawAccum = 0
    }
    const nextSway = dreaming && !drag ? 0.03 * Math.sin((Math.PI * 2 * now) / 18000) : 0
    if (nextSway !== sway.value) sway.value = nextSway
  }
  if (dreaming) {
    const target = orbTarget.value
    const tau = props.offloading ? 700 : 320
    const blend = 1 - Math.exp(-dt / tau)
    orb.left += (target.left - orb.left) * blend
    orb.top += (target.top - orb.top) * blend
    if (render && (Math.abs(orb.left - orbPos.value.left) > 0.05 || Math.abs(orb.top - orbPos.value.top) > 0.05))
      orbPos.value = { left: orb.left, top: orb.top }
    const rotation = Math.floor(now / 4000)
    if (rotation !== threadRotation.value) threadRotation.value = rotation
    // Light motes along the reading threads: forward while generating, back to the orb while verifying.
    const threads = dreamThreads.value
    const period = props.offloading ? 2800 : 1600
    const backwards = stage.value === 'verifying'
    moveMotes(dreamMoteLayer.value, threads.length, index => {
      const thread = threads.at(index)
      if (!thread) return null
      const phase = (now / period + index * 0.09) % 1
      const eased = easeInOut(phase)
      const control = memoryEdgeControl(orb, thread.point)
      const spot = quadraticPoint(orb, control, thread.point, backwards ? 1 - eased : eased)
      return { ...spot, opacity: 0.35 + 0.65 * Math.sin(Math.PI * phase) }
    })
  }
  // Model ↔ memory motes: recalls flow into the core, writes flow out to the memory.
  const slots = linkMoteSlots.value
  if (slots.length) {
    const rotation = Math.floor(now / 3000)
    if (rotation !== moteRotation.value) moteRotation.value = rotation
    const { byId } = scene.value
    const core = byId.get(MODEL_NODE_ID)
    const wall = Date.now()
    moveMotes(linkMoteLayer.value, slots.length, index => {
      const slot = slots.at(index)
      const node = slot ? byId.get(slot.nodeId) : undefined
      if (!slot || !node || !core) return null
      const phase = (now / 1500 + slot.offset) % 1
      const eased = easeInOut(phase)
      const control = memoryEdgeControl(core, node, 26)
      const spot = LINK_TOWARD_CORE.has(slot.state)
        ? quadraticPoint(node, control, core, eased)
        : quadraticPoint(core, control, node, eased)
      return { ...spot, opacity: linkLife(slot.link, wall) * (0.3 + 0.7 * Math.sin(Math.PI * phase)) }
    })
  }
  if (now - clockAt > 1000) {
    clockAt = now
    clock.value = Date.now()
  }
  if (needsFrame()) frame = requestAnimationFrame(tick)
  else lastFrame = 0
}
watch([spinning, animatedDream, () => linkMoteSlots.value.length], ensureLoop, { immediate: true })
// Link ages must keep fading even when nothing else animates (reduced motion, idle page).
let clockTimer: ReturnType<typeof setInterval> | undefined
watch(
  () => props.links.length > 0,
  active => {
    if (clockTimer) clearInterval(clockTimer)
    clockTimer = undefined
    if (active)
      clockTimer = setInterval(() => {
        clock.value = Date.now()
      }, 1000)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (frame !== undefined) cancelAnimationFrame(frame)
  frame = undefined
  if (clockTimer) clearInterval(clockTimer)
})
</script>
<template>
  <div
    class="memory-graph"
    :class="{
      'is-dreaming': dreamVisible,
      'is-offloading': offloading,
      'has-selection': hasSelection,
      'is-dragging': dragging,
      'has-wave': !!wave,
      'is-thinking': phase !== 'idle',
      'is-ambient': ambient,
      'is-dense': scene.dense,
      'has-links': linkEdges.length > 0,
      'has-hover': !!hoverId,
      'is-reduced': reducedMotion,
    }"
    :data-stage="stage"
    :data-phase="phase"
    :style="paints"
  >
    <div v-if="!ambient" class="memory-graph__tools" role="group" aria-label="3D-Ansicht steuern">
      <button type="button" aria-label="Verkleinern" @click="setZoom(-ZOOM_STEP)">−</button>
      <button type="button" aria-label="Vergrößern" @click="setZoom(ZOOM_STEP)">+</button>
      <button type="button" @click="reset">Zentrieren</button>
    </div>
    <Transition name="dream-chip">
      <div
        v-if="dreamVisible && !ambient"
        class="memory-graph__dream"
        :class="{ 'is-failed': runOutcome === 'failed', 'is-interrupted': runOutcome === 'interrupted' }"
        role="status"
        :style="{ '--mg-progress': progress / 100 }"
      >
        <span class="memory-graph__dream-dot" aria-hidden="true" />
        Träumt · {{ dreamStage || 'Leerlauf-Pflege' }}<template v-if="offloading"> · langsam (Auslagerung)</template>
      </div>
    </Transition>
    <svg
      ref="svgEl"
      viewBox="0 0 800 500"
      :preserveAspectRatio="ambient ? 'xMidYMid slice' : 'xMidYMid meet'"
      tabindex="0"
      role="group"
      aria-label="Drehbare 3D-Gedächtniskarte. Pfeiltasten drehen, Plus und Minus zoomen. Einträge auch in der Liste auswählbar."
      v-on="pointerHandlers"
      @keydown="key"
    >
      <defs>
        <radialGradient :id="`${uid}-glass`" class="grad grad--accent" cx="0.36" cy="0.32" r="0.78" fx="0.3" fy="0.26">
          <stop offset="0" class="st-glass-0" stop-color="var(--ai-accent)" />
          <stop offset="0.18" class="st-glass-1" stop-color="var(--ai-accent)" />
          <stop offset="0.55" class="st-glass-2" stop-color="var(--ai-accent)" />
          <stop offset="1" class="st-glass-3" stop-color="var(--ai-accent)" />
        </radialGradient>
        <radialGradient
          :id="`${uid}-glass-born`"
          class="grad grad--green"
          cx="0.36"
          cy="0.32"
          r="0.78"
          fx="0.3"
          fy="0.26"
        >
          <stop offset="0" class="st-glass-0" stop-color="var(--ai-green)" />
          <stop offset="0.18" class="st-glass-1" stop-color="var(--ai-green)" />
          <stop offset="0.55" class="st-glass-2" stop-color="var(--ai-green)" />
          <stop offset="1" class="st-glass-3" stop-color="var(--ai-green)" />
        </radialGradient>
        <radialGradient
          :id="`${uid}-glass-conflict`"
          class="grad grad--orange"
          cx="0.36"
          cy="0.32"
          r="0.78"
          fx="0.3"
          fy="0.26"
        >
          <stop offset="0" class="st-glass-0" stop-color="var(--ai-orange)" />
          <stop offset="0.18" class="st-glass-1" stop-color="var(--ai-orange)" />
          <stop offset="0.55" class="st-glass-2" stop-color="var(--ai-orange)" />
          <stop offset="1" class="st-glass-3" stop-color="var(--ai-orange)" />
        </radialGradient>
        <radialGradient
          :id="`${uid}-glass-lit`"
          class="grad grad--accent"
          cx="0.36"
          cy="0.32"
          r="0.78"
          fx="0.3"
          fy="0.26"
        >
          <stop offset="0" class="st-lit-0" stop-color="var(--ai-accent)" />
          <stop offset="0.32" class="st-lit-1" stop-color="var(--ai-accent)" />
          <stop offset="0.7" class="st-lit-2" stop-color="var(--ai-accent)" />
          <stop offset="1" class="st-lit-3" stop-color="var(--ai-accent)" />
        </radialGradient>
        <linearGradient :id="`${uid}-rim`" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" class="st-rim-0" stop-color="var(--ai-ink)" />
          <stop offset="0.35" class="st-rim-1" stop-color="var(--ai-ink)" />
          <stop offset="0.65" class="st-rim-2" stop-color="var(--ai-page)" />
          <stop offset="1" class="st-rim-3" stop-color="var(--ai-page)" />
        </linearGradient>
        <linearGradient :id="`${uid}-ring`" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" class="st-ring-0" stop-color="var(--ai-accent)" />
          <stop offset="0.5" class="st-ring-1" stop-color="var(--ai-accent)" />
          <stop offset="1" class="st-ring-2" stop-color="var(--ai-accent)" />
        </linearGradient>
        <radialGradient :id="`${uid}-glow`" class="grad grad--accent" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" class="st-glow-0" stop-color="var(--ai-accent)" />
          <stop offset="0.45" class="st-glow-1" stop-color="var(--ai-accent)" />
          <stop offset="1" class="st-glow-2" stop-color="var(--ai-accent)" />
        </radialGradient>
        <radialGradient :id="`${uid}-glow-green`" class="grad grad--green" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" class="st-glow-0" stop-color="var(--ai-green)" />
          <stop offset="0.45" class="st-glow-1" stop-color="var(--ai-green)" />
          <stop offset="1" class="st-glow-2" stop-color="var(--ai-green)" />
        </radialGradient>
        <radialGradient :id="`${uid}-glow-orange`" class="grad grad--orange" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" class="st-glow-0" stop-color="var(--ai-orange)" />
          <stop offset="0.45" class="st-glow-1" stop-color="var(--ai-orange)" />
          <stop offset="1" class="st-glow-2" stop-color="var(--ai-orange)" />
        </radialGradient>
        <radialGradient :id="`${uid}-mist`" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" class="st-mist-0" stop-color="var(--ai-accent)" />
          <stop offset="0.4" class="st-mist-1" stop-color="var(--ai-accent)" />
          <stop offset="0.75" class="st-mist-2" stop-color="var(--ai-accent)" />
          <stop offset="1" class="st-mist-3" stop-color="var(--ai-accent)" />
        </radialGradient>
        <radialGradient :id="`${uid}-mist-lit`" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" class="st-mistlit-0" stop-color="var(--ai-accent)" />
          <stop offset="0.4" class="st-mistlit-1" stop-color="var(--ai-accent)" />
          <stop offset="0.75" class="st-mistlit-2" stop-color="var(--ai-accent)" />
          <stop offset="1" class="st-mistlit-3" stop-color="var(--ai-accent)" />
        </radialGradient>
        <radialGradient :id="`${uid}-floor`" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" class="st-floor-0" stop-color="var(--ai-accent)" />
          <stop offset="1" class="st-floor-1" stop-color="var(--ai-accent)" />
        </radialGradient>
        <radialGradient :id="`${uid}-aura`" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" class="st-aura-0" stop-color="var(--ai-accent)" />
          <stop offset="0.4" class="st-aura-1" stop-color="var(--ai-accent)" />
          <stop offset="1" class="st-aura-2" stop-color="var(--ai-accent)" />
        </radialGradient>
        <radialGradient :id="`${uid}-core`" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" class="st-core-0" stop-color="var(--ai-ink)" />
          <stop offset="0.55" class="st-core-1" stop-color="var(--ai-ink)" />
          <stop offset="1" class="st-core-2" stop-color="var(--ai-accent)" />
        </radialGradient>
        <filter :id="`${uid}-blur`" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter :id="`${uid}-blur-core`" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>

      <!-- L0 space: drifting stars and slowly turning orbit rings (knowledge space only) -->
      <g v-if="!ambient" class="space" aria-hidden="true">
        <g class="stars">
          <circle
            v-for="(star, index) in stars"
            :key="index"
            class="star"
            :class="{ 'star--far': star.far }"
            :cx="star.x"
            :cy="star.y"
            :r="star.r"
            :style="{ '--twinkle-delay': `${star.delay}ms`, '--twinkle': `${star.duration}ms` }"
          />
        </g>
        <g class="orbits">
          <ellipse
            v-for="(ring, index) in ORBIT_RINGS"
            :key="index"
            class="orbit"
            :class="{ 'orbit--reverse': ring.reverse }"
            cx="400"
            cy="262"
            :rx="ring.rx"
            :ry="ring.ry"
            pathLength="100"
            :style="{ '--orbit': `${ring.duration}s`, '--orbit-index': index }"
          />
        </g>
      </g>
      <!-- L1 mist: three soft ellipses per system hub, no filter -->
      <g class="mist" aria-hidden="true">
        <g v-for="blob in mistBlobs" :key="blob.system" :style="{ '--dp-hub': blob.hub.dp }">
          <ellipse class="mist-far" :cx="blob.hub.left" :cy="blob.hub.top" :rx="blob.rx * 1.5" :ry="blob.ry * 1.5" />
          <ellipse class="mist-core" :cx="blob.hub.left" :cy="blob.hub.top" :rx="blob.rx" :ry="blob.ry" />
          <ellipse
            class="mist-lit"
            :class="{ 'is-lit': blob.lit }"
            :cx="blob.hub.left"
            :cy="blob.hub.top"
            :rx="blob.rx"
            :ry="blob.ry"
          />
        </g>
      </g>
      <!-- L2 floor ring -->
      <path v-if="scene.floorD" class="floor" :d="scene.floorD" aria-hidden="true" />
      <!-- L3 edges: grouping bundles, model spokes, stored relations -->
      <g class="edges" aria-hidden="true">
        <path v-if="scene.bundleNear" class="edge edge--group is-near" :d="scene.bundleNear" />
        <path v-if="scene.bundleMid" class="edge edge--group" :d="scene.bundleMid" />
        <path v-if="scene.bundleFar" class="edge edge--group is-far" :d="scene.bundleFar" />
        <path v-if="scene.spokesD" class="edge edge--spoke" :d="scene.spokesD" />
      </g>
      <g class="edges">
        <path
          v-for="edge in scene.stored"
          :key="edge.key"
          class="edge edge--stored"
          :class="{ 'is-near': edge.band === 'near', 'is-far': edge.band === 'far' }"
          :d="edge.path"
        >
          <title>{{ edge.kind }}</title>
        </path>
      </g>
      <!-- L4 special edges: selected (+flow), born (draw in), ghost (fade) -->
      <g class="edges edges--special">
        <path v-if="scene.selectedBundle" class="edge edge--selected" :d="scene.selectedBundle" aria-hidden="true" />
        <path
          v-for="edge in scene.special"
          :key="edge.key"
          class="edge"
          :class="edge.cls"
          :d="edge.path"
          :pathLength="edge.cls === 'edge--born' ? 1 : undefined"
        >
          <title>{{ edge.kind }}</title>
        </path>
        <path v-for="(flow, index) in scene.flows" :key="index" class="edge-flow" :d="flow" aria-hidden="true" />
      </g>
      <!-- L4b live model ↔ memory links -->
      <g class="links" aria-hidden="true">
        <path
          v-for="edge in linkEdges"
          :key="edge.key"
          class="link"
          :class="`link--${edge.state}`"
          :d="edge.path"
          :pathLength="edge.written ? 1 : undefined"
          :style="{ opacity: edge.opacity }"
        />
        <g ref="linkMoteLayer" class="link-motes">
          <circle
            v-for="slot in linkMoteSlots"
            :key="slot.key"
            class="link-mote"
            :class="`link-mote--${slot.state}`"
            r="2.1"
            opacity="0"
          />
        </g>
      </g>
      <!-- L5 dream threads, motes and the commit wave -->
      <g v-if="dreamVisible" class="dream-under" aria-hidden="true">
        <path v-for="thread in dreamThreads" :key="thread.id" class="dream-thread" :d="thread.path" />
        <g ref="dreamMoteLayer" class="dream-motes">
          <template v-if="animatedDream">
            <circle v-for="thread in dreamThreads" :key="thread.id" class="dream-mote" r="2.2" opacity="0" />
          </template>
        </g>
      </g>
      <g
        v-if="wave && waveHub"
        :key="wave.key"
        class="dream-wave"
        aria-hidden="true"
        :transform="`translate(${waveHub.left} ${waveHub.top})`"
      >
        <ellipse class="wave-ring" rx="12" ry="7.4" />
        <ellipse class="wave-ring wave-ring--b" rx="12" ry="7.4" @animationend="endWave" />
      </g>
      <!-- L6 nodes -->
      <g :key="sceneEntrance" class="nodes" :class="{ 'nodes--enter': !ambient }">
        <g
          v-for="entry in entries.regular"
          :key="entry.point.id"
          :data-node="entry.point.id"
          :class="entry.cls"
          :transform="`translate(${entry.point.left} ${entry.point.top}) scale(${entry.point.scale})`"
          :style="entry.style"
        >
          <circle class="hit" :r="entry.hit" fill="transparent" />
          <circle
            v-for="layer in entry.layers"
            :key="layer.key"
            :class="layer.cls"
            :r="layer.radius"
            :cx="layer.cx"
            :cy="layer.cy"
          />
          <g
            v-if="entry.pill"
            class="pill"
            :class="{
              'pill--hub': entry.pill.hub,
              'pill--model': entry.pill.model,
              'pill--minor': !entry.pill.hub && !entry.pill.model,
            }"
            :transform="`scale(${entry.point.unscale}) translate(${entry.pill.left} ${entry.pill.top})`"
          >
            <rect
              :y="-entry.pill.height"
              :width="entry.pill.width"
              :height="entry.pill.height"
              :rx="entry.pill.height / 2"
            />
            <line
              v-if="entry.pill.hub || entry.pill.model"
              class="pill-edge"
              x1="8"
              :y1="-entry.pill.height + 1"
              :x2="entry.pill.width - 8"
              :y2="-entry.pill.height + 1"
            />
            <circle v-if="entry.pill.hub" class="pill-dot" :cx="entry.pill.dotX" :cy="entry.pill.textY" r="1.8" />
            <text :x="entry.pill.textX" :y="entry.pill.textY" :style="{ fontSize: `${entry.pill.fontSize}px` }">
              {{ entry.pill.text }}
              <tspan
                v-if="entry.pill.count"
                class="pill-count"
                dx="0.6em"
                :style="{ fontSize: `${entry.pill.fontSize * 0.9}px` }"
              >
                {{ entry.pill.count }}
              </tspan>
            </text>
          </g>
          <text
            v-if="entry.flag"
            class="flag"
            :class="entry.flag.cls"
            :transform="`scale(${entry.point.unscale}) translate(${entry.flag.left} ${entry.flag.top})`"
          >
            {{ entry.flag.text }}
          </text>
          <title>{{ entry.point.label }} · {{ entry.point.kind }}</title>
        </g>
      </g>
      <!-- L7 transient nodes (born / ghost) in a stable order -->
      <g class="nodes nodes--transient">
        <g
          v-for="entry in entries.transient"
          :key="entry.point.id"
          :data-node="entry.point.id"
          :class="entry.cls"
          :transform="`translate(${entry.point.left} ${entry.point.top}) scale(${entry.point.scale})`"
          :style="entry.style"
        >
          <circle class="hit" :r="entry.hit" fill="transparent" />
          <circle
            v-for="layer in entry.layers"
            :key="layer.key"
            :class="layer.cls"
            :r="layer.radius"
            :cx="layer.cx"
            :cy="layer.cy"
          />
          <g
            v-if="entry.pill"
            class="pill pill--minor"
            :transform="`scale(${entry.point.unscale}) translate(${entry.pill.left} ${entry.pill.top})`"
          >
            <rect
              :y="-entry.pill.height"
              :width="entry.pill.width"
              :height="entry.pill.height"
              :rx="entry.pill.height / 2"
            />
            <text :x="entry.pill.textX" :y="entry.pill.textY" :style="{ fontSize: `${entry.pill.fontSize}px` }">
              {{ entry.pill.text }}
            </text>
          </g>
          <text
            v-if="entry.flag"
            class="flag"
            :class="entry.flag.cls"
            :transform="`scale(${entry.point.unscale}) translate(${entry.flag.left} ${entry.flag.top})`"
          >
            {{ entry.flag.text }}
          </text>
          <title>{{ entry.point.label }} · {{ entry.point.kind }}</title>
        </g>
      </g>
      <!-- L8 hover pill -->
      <g
        v-if="hoverPill"
        class="hover-pill pill pill--minor"
        aria-hidden="true"
        :transform="`translate(${hoverPill.left} ${hoverPill.top})`"
      >
        <rect :y="-hoverPill.height" :width="hoverPill.width" :height="hoverPill.height" :rx="hoverPill.height / 2" />
        <text x="8" :y="-hoverPill.height / 2">{{ hoverPill.text }}</text>
      </g>
      <!-- L9 dream light -->
      <Transition name="dream-light">
        <g v-if="dreamVisible" class="dream-light" aria-hidden="true">
          <g class="dream-orb-group" :transform="`translate(${orbShown.left} ${orbShown.top})`">
            <circle class="dream-aura" r="44" />
            <circle class="dream-glow" r="12" />
            <circle class="dream-track" r="17" />
            <circle
              class="dream-progress"
              r="17"
              pathLength="100"
              transform="rotate(-90)"
              :stroke-dasharray="`${progress} 100`"
            />
            <circle class="dream-orb" r="4.5" />
            <g v-if="animatedDream" class="dream-mote-orbit dream-mote-orbit--a"><circle r="1.5" cx="9" /></g>
            <g v-if="animatedDream" class="dream-mote-orbit dream-mote-orbit--b"><circle r="1.5" cx="14" /></g>
            <text class="dream-stage" x="24" y="3.5">{{ stageWord }}</text>
          </g>
        </g>
      </Transition>
    </svg>
    <p v-if="!ambient">
      Ziehen: drehen · Rad, +/−: zoomen · Knoten: Details<br /><span
        >Linie: gespeicherte Beziehung · gestrichelt: Zuordnung. Abstand ist keine Ähnlichkeitsbewertung. Modell ↔
        Erinnerung: Ring = wird gelesen · grün = im Kontext/neu · orange = geändert · rot = gelöscht · gestrichelt =
        nicht übernommen. Beim Träumen: NEU = neu · Verblassen = ersetzt · Doppelring ! = Konflikt · Welle =
        übernommen.</span
      >
    </p>
  </div>
</template>
<style scoped>
/* ------------------------------------------------------------------ tokens */
@property --mg-dim {
  syntax: '<number>';
  inherits: true;
  initial-value: 1;
}
.memory-graph {
  --mg-light: var(--ai-ink);
  --mg-shade: var(--ai-page);
  --mg-mist: 0.16;
  --mg-aura: 0.45;
  --mg-pill: 78%;
  --mg-vignette: 16%;
  --mg-edge: var(--g-edge, rgba(255, 255, 255, 0.28));
  --mg-ease: var(--ease, cubic-bezier(0.32, 0.72, 0, 1));
  position: relative;
  overflow: hidden;
  isolation: isolate;
  contain: layout paint;
  border: 1px solid var(--ai-line);
  border-radius: 16px;
  background: radial-gradient(
    120% 90% at 50% 0%,
    color-mix(in srgb, var(--ai-accent) 7%, var(--ai-canvas)) 0%,
    var(--ai-canvas) 55%,
    color-mix(in srgb, var(--mg-shade) 10%, var(--ai-canvas)) 100%
  );
  box-shadow:
    inset 0 1px 0 var(--mg-edge),
    inset 0 -1px 0 color-mix(in srgb, var(--mg-shade) 18%, transparent);
  transition: box-shadow 900ms var(--mg-ease);
}
/* Theme overrides need the html ancestor, so the whole selector is global (Vue's :global replaces the selector). */
:global(html[data-theme='light'] .memory-graph),
:global(.ai-light .memory-graph) {
  --mg-light: var(--ai-surface);
  --mg-shade: var(--ai-ink);
  --mg-mist: 0.11;
  --mg-aura: 0.55;
  --mg-pill: 86%;
  --mg-vignette: 9%;
}
.memory-graph::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: radial-gradient(
    80% 70% at 50% 45%,
    transparent 55%,
    color-mix(in srgb, var(--mg-shade) var(--mg-vignette), transparent) 100%
  );
}
.memory-graph.is-dreaming {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ai-accent) 30%, transparent),
    inset 0 -80px 160px -80px color-mix(in srgb, var(--ai-accent) 20%, transparent);
}
.memory-graph.is-dreaming::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(60% 50% at 20% 10%, color-mix(in srgb, var(--ai-accent) 16%, transparent), transparent 70%),
    radial-gradient(50% 60% at 85% 90%, color-mix(in srgb, var(--ai-accent) 12%, transparent), transparent 70%);
  filter: blur(40px);
  will-change: transform, opacity;
  animation: mg-nebel 14s ease-in-out infinite alternate;
}
:global(html[data-theme='light'] .memory-graph.is-dreaming::before),
:global(.ai-light .memory-graph.is-dreaming::before) {
  opacity: 0.6;
}
.memory-graph.is-dreaming[data-stage='scanning']::after {
  background: linear-gradient(
    105deg,
    transparent 40%,
    color-mix(in srgb, var(--mg-light) 7%, transparent) 50%,
    transparent 60%
  );
  inset: 0 -50%;
  animation: mg-sweep 7s linear infinite;
}
.memory-graph.is-ambient::after {
  display: none;
}
/* ------------------------------------------------------------------ space layer */
.star {
  fill: var(--mg-light);
  opacity: 0.22;
  transform-box: fill-box;
  transform-origin: center;
  animation: mg-twinkle var(--twinkle, 6s) ease-in-out var(--twinkle-delay, 0ms) infinite alternate;
}
.star--far {
  opacity: 0.12;
}
.orbit {
  fill: none;
  stroke: color-mix(in srgb, var(--ai-accent) 26%, transparent);
  stroke-width: 0.7px;
  stroke-dasharray: 0.6 2.2;
  vector-effect: non-scaling-stroke;
  opacity: calc(0.55 - var(--orbit-index, 0) * 0.14);
  animation: mg-orbit var(--orbit, 60s) linear infinite;
}
.orbit--reverse {
  animation-direction: reverse;
}
.is-dragging .orbit,
.is-reduced .orbit,
.is-reduced .star {
  animation-play-state: paused;
}
@keyframes mg-twinkle {
  from {
    opacity: 0.08;
    transform: scale(0.8);
  }
  to {
    opacity: 0.42;
    transform: scale(1.25);
  }
}
@keyframes mg-orbit {
  from {
    stroke-dashoffset: 0;
  }
  to {
    stroke-dashoffset: -100;
  }
}
/* Entrance: nodes bloom from the back to the front once per scene. */
.nodes--enter g[data-node] {
  animation: mg-enter 720ms var(--mg-ease) var(--enter-delay, 0ms) both;
}
.is-reduced .nodes--enter g[data-node] {
  animation: none;
}
@keyframes mg-enter {
  from {
    opacity: 0;
    filter: blur(6px);
  }
  60% {
    filter: blur(0);
  }
  to {
    opacity: 1;
    filter: blur(0);
  }
}
/* Hover: the node and its neighbourhood step forward, the rest recedes. */
.memory-graph.has-hover .nodes g[data-node]:not(.is-hover):not(.is-hover-near):not(.selected):not(.model) {
  opacity: 0.38;
  transition: opacity 320ms var(--mg-ease);
}
.memory-graph .nodes g[data-node] {
  transition: opacity 320ms var(--mg-ease);
}
.memory-graph.has-hover .nodes g.is-hover-near .body {
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--ai-accent) 55%, transparent));
}
.memory-graph.has-hover .nodes g.is-hover .body {
  filter: drop-shadow(0 0 12px color-mix(in srgb, var(--ai-accent) 80%, transparent));
}
.memory-graph.has-hover .edges .edge--stored,
.memory-graph.has-hover .edges .edge--group {
  opacity: 0.35;
  transition: opacity 320ms var(--mg-ease);
}
/* Relations carry a slow current so the space never looks frozen. */
.memory-graph:not(.is-ambient):not(.is-reduced) .edge--stored.is-near {
  stroke-dasharray: 3 9;
  animation: mg-current 4.5s linear infinite;
}
@keyframes mg-current {
  to {
    stroke-dashoffset: -48;
  }
}
@keyframes mg-nebel {
  from {
    opacity: 0.55;
    transform: translate3d(-2%, 0, 0) scale(1);
  }
  to {
    opacity: 1;
    transform: translate3d(2%, -2%, 0) scale(1.04);
  }
}
@keyframes mg-sweep {
  from {
    transform: translateX(-60%);
  }
  to {
    transform: translateX(60%);
  }
}
svg {
  display: block;
  width: 100%;
  min-height: 280px;
  max-height: 65vh;
  touch-action: none;
  cursor: grab;
  position: relative;
  z-index: 1;
  font-family: var(--ai-font);
}
svg:active,
.is-dragging svg {
  cursor: grabbing;
}
.is-ambient svg {
  cursor: default;
}
svg:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: -3px;
  border-radius: 16px;
}

/* ------------------------------------------------------------------ gradient stops (per theme via tokens) */
.grad--accent {
  --mg-base: var(--ai-accent);
}
.grad--green {
  --mg-base: var(--ai-green);
}
.grad--orange {
  --mg-base: var(--ai-orange);
}
.st-glass-0 {
  stop-color: color-mix(in srgb, var(--mg-light) 72%, var(--mg-base));
}
.st-glass-1 {
  stop-color: color-mix(in srgb, var(--mg-light) 28%, var(--mg-base));
}
.st-glass-2 {
  stop-color: var(--mg-base);
}
.st-glass-3 {
  stop-color: color-mix(in srgb, var(--mg-base) 58%, var(--mg-shade));
}
.st-lit-0 {
  stop-color: var(--mg-light);
}
.st-lit-1 {
  stop-color: color-mix(in srgb, var(--mg-light) 55%, var(--mg-base));
}
.st-lit-2 {
  stop-color: var(--mg-base);
}
.st-lit-3 {
  stop-color: color-mix(in srgb, var(--mg-base) 75%, var(--mg-shade));
}
.st-rim-0 {
  stop-color: var(--mg-light);
  stop-opacity: 0.85;
}
.st-rim-1 {
  stop-color: var(--mg-light);
  stop-opacity: 0.1;
}
.st-rim-2 {
  stop-color: var(--mg-shade);
  stop-opacity: 0.06;
}
.st-rim-3 {
  stop-color: var(--mg-shade);
  stop-opacity: 0.4;
}
.st-ring-0 {
  stop-color: var(--ai-accent);
  stop-opacity: 0;
}
.st-ring-1 {
  stop-color: var(--mg-light);
  stop-opacity: 0.95;
}
.st-ring-2 {
  stop-color: var(--ai-accent);
  stop-opacity: 0;
}
.st-glow-0 {
  stop-color: var(--mg-base);
  stop-opacity: 0.4;
}
.st-glow-1 {
  stop-color: var(--mg-base);
  stop-opacity: 0.14;
}
.st-glow-2 {
  stop-color: var(--mg-base);
  stop-opacity: 0;
}
.st-mist-0 {
  stop-color: var(--ai-accent);
  stop-opacity: var(--mg-mist);
}
.st-mist-1 {
  stop-color: var(--ai-accent);
  stop-opacity: calc(var(--mg-mist) * 0.55);
}
.st-mist-2 {
  stop-color: var(--ai-accent);
  stop-opacity: calc(var(--mg-mist) * 0.18);
}
.st-mist-3 {
  stop-color: var(--ai-accent);
  stop-opacity: 0;
}
.st-mistlit-0 {
  stop-color: var(--ai-accent);
  stop-opacity: calc(var(--mg-mist) * 1.6);
}
.st-mistlit-1 {
  stop-color: var(--ai-accent);
  stop-opacity: calc(var(--mg-mist) * 0.88);
}
.st-mistlit-2 {
  stop-color: var(--ai-accent);
  stop-opacity: calc(var(--mg-mist) * 0.29);
}
.st-mistlit-3 {
  stop-color: var(--ai-accent);
  stop-opacity: 0;
}
.st-floor-0 {
  stop-color: var(--ai-accent);
  stop-opacity: 0.08;
}
.st-floor-1 {
  stop-color: var(--ai-accent);
  stop-opacity: 0;
}
.st-aura-0 {
  stop-color: var(--ai-accent);
  stop-opacity: var(--mg-aura);
}
.st-aura-1 {
  stop-color: var(--ai-accent);
  stop-opacity: 0.18;
}
.st-aura-2 {
  stop-color: var(--ai-accent);
  stop-opacity: 0;
}
.st-core-0 {
  stop-color: var(--mg-light);
  stop-opacity: 1;
}
.st-core-1 {
  stop-color: var(--mg-light);
  stop-opacity: 0.92;
}
.st-core-2 {
  stop-color: var(--ai-accent);
  stop-opacity: 0.55;
}

/* ------------------------------------------------------------------ background layers */
.mist ellipse {
  pointer-events: none;
}
.mist-far {
  fill: var(--mg-u-mist);
  opacity: calc(0.35 * var(--dp-hub, 1));
}
.mist-core {
  fill: var(--mg-u-mist);
  opacity: var(--dp-hub, 1);
}
.mist-lit {
  fill: var(--mg-u-mist-lit);
  opacity: 0;
  transition: opacity 900ms var(--mg-ease);
}
.mist-lit.is-lit {
  opacity: var(--dp-hub, 1);
}
.floor {
  fill: var(--mg-u-floor);
  stroke: var(--ai-line-strong);
  stroke-width: 1;
  opacity: 0.35;
  pointer-events: none;
  transition: stroke 900ms var(--mg-ease);
}
.is-dreaming .floor {
  stroke: color-mix(in srgb, var(--ai-accent) 45%, var(--ai-line-strong));
}

/* ------------------------------------------------------------------ edges */
.edge,
.edge-flow,
.link,
.dream-thread {
  fill: none;
  stroke-linecap: round;
  pointer-events: none;
}
.edge--group {
  stroke: var(--ai-faint);
  stroke-dasharray: 2 5;
  stroke-width: 0.7;
  opacity: 0.2;
}
.edge--group.is-near {
  stroke-width: 0.8;
  opacity: 0.3;
}
.edge--group.is-far {
  stroke-width: 0.6;
  opacity: 0.11;
}
.edge--spoke {
  stroke: var(--ai-accent);
  stroke-width: 0.9;
  opacity: 0.28;
}
.edge--stored {
  stroke: color-mix(in srgb, var(--ai-accent) 70%, var(--ai-line-strong));
  stroke-width: 0.9;
  opacity: calc(0.36 * var(--mg-dim, 1));
  pointer-events: stroke;
}
.edge--stored.is-near {
  stroke-width: 1.1;
  opacity: calc(0.55 * var(--mg-dim, 1));
}
.edge--stored.is-far {
  stroke-width: 0.7;
  opacity: calc(0.2 * var(--mg-dim, 1));
}
.edge--selected {
  stroke: var(--ai-accent);
  stroke-width: 1.6;
  opacity: 0.95;
  transition: opacity 600ms var(--mg-ease);
}
.is-dense .edge--selected {
  stroke-width: 1.1;
  opacity: 0.5;
}
.is-dreaming .edge--selected,
.has-links .edge--selected {
  opacity: 0.45;
}
.is-dense.is-dreaming .edge--selected,
.is-dense.has-links .edge--selected {
  opacity: 0.22;
}
.edge-flow {
  stroke: var(--mg-light);
  stroke-width: 1.1;
  opacity: 0.55;
  transition: opacity 600ms var(--mg-ease);
}
.is-dreaming .edge-flow,
.has-links .edge-flow {
  opacity: 0.25;
  stroke-dasharray: 8 16;
  animation: mg-flow 1.4s linear infinite;
}
.edge--born {
  stroke: var(--ai-green);
  stroke-width: 0.9;
  opacity: 0.8;
  stroke-dasharray: 1;
  animation: mg-draw 900ms ease-out 150ms both;
}
.edge--ghost {
  stroke: var(--ai-faint);
  stroke-dasharray: 1 3;
  opacity: 0.4;
  animation: mg-fade 7s linear forwards;
}
.is-ambient .edge--group {
  opacity: 0.12;
}
.is-ambient .edge--stored {
  opacity: 0.22;
}
.is-ambient .edge-flow,
.is-ambient .hover-pill {
  display: none;
}

/* ------------------------------------------------------------------ live links model ↔ memory */
.link {
  transition: opacity 800ms var(--mg-ease);
}
.link--recalled {
  stroke: var(--ai-accent);
  stroke-width: 1.1;
  stroke-dasharray: 4 6;
  animation: mg-flow-back 1.2s linear infinite;
}
.link--included {
  stroke: var(--ai-green);
  stroke-width: 1.8;
}
.link--omitted {
  stroke: var(--ai-muted);
  stroke-width: 0.8;
  stroke-dasharray: 2 5;
}
.link--written {
  stroke: var(--ai-green);
  stroke-width: 1.6;
  stroke-dasharray: 1;
  animation: mg-draw 900ms ease-out both;
}
.link--updated {
  stroke: var(--ai-orange);
  stroke-width: 1.4;
}
.link--removed {
  stroke: var(--ai-red);
  stroke-width: 1.2;
  stroke-dasharray: 3 4;
  animation: mg-fade-out 1.6s ease-out forwards;
}
.link-mote {
  fill: var(--mg-light);
  pointer-events: none;
}
.link-mote--recalled {
  fill: color-mix(in srgb, var(--mg-light) 55%, var(--ai-accent));
}
.link-mote--included,
.link-mote--written {
  fill: color-mix(in srgb, var(--mg-light) 45%, var(--ai-green));
}
.link-mote--updated {
  fill: color-mix(in srgb, var(--mg-light) 40%, var(--ai-orange));
}

/* ------------------------------------------------------------------ nodes */
g[data-node] {
  cursor: pointer;
  transition: --mg-dim 400ms var(--mg-ease);
}
.is-ambient g[data-node] {
  cursor: default;
}
g[data-node] > circle {
  vector-effect: non-scaling-stroke;
}
g[data-node] > circle:not(.body):not(.hit):not(.core-body):not(.core-halo) {
  transform-box: fill-box;
  transform-origin: center;
}
.body {
  fill: var(--mg-u-glass);
  stroke: var(--mg-u-rim);
  stroke-width: 1px;
  fill-opacity: calc(var(--dp, 1) * var(--mg-dim, 1));
  stroke-opacity: calc(var(--dp, 1) * var(--mg-dim, 1));
  transform-box: fill-box;
  transform-origin: center;
  transition:
    stroke-width 160ms var(--mg-ease),
    fill 500ms var(--mg-ease),
    stroke 500ms var(--mg-ease);
}
.shell,
.glow,
.lit,
.halo,
.warm,
.warn,
.ripple,
.ring,
.pick,
.flag,
.link-ring,
.burst,
.pulse,
.flash,
.remnant {
  opacity: calc(var(--dp, 1) * var(--mg-dim, 1));
}
.hub .body {
  stroke-width: 1.25px;
}
.shell {
  fill: none;
  stroke: var(--mg-u-rim);
  stroke-width: 1px;
  opacity: calc(0.55 * var(--dp, 1) * var(--mg-dim, 1));
}
.is-near .body {
  stroke-width: 1.25px;
}
.is-near.hub .body {
  stroke-width: 1.5px;
}
.is-far .body {
  stroke: var(--ai-line-strong);
  fill-opacity: calc(0.85 * var(--dp, 1) * var(--mg-dim, 1));
}
.is-ambient .body {
  stroke: var(--ai-line-strong);
}
g[data-node]:hover .body {
  stroke-width: 1.5px;
}
.is-adjacent .body {
  stroke-width: 1.25px;
}
.glow {
  fill: var(--mg-u-glow);
  transition: opacity 300ms var(--mg-ease);
}
/* touched / reading */
.lit {
  fill: var(--mg-light);
  opacity: 0;
  transition: opacity 900ms var(--mg-ease);
}
.is-touched .lit {
  opacity: calc(0.35 * var(--dp, 1) * var(--mg-dim, 1));
}
.is-reading .lit {
  opacity: calc(var(--dp, 1) * var(--mg-dim, 1));
  transition-duration: 600ms;
}
.warm {
  fill: none;
  stroke: var(--ai-accent);
  stroke-opacity: 0.5;
  stroke-width: 1px;
}
.halo {
  fill: none;
  stroke: var(--ai-accent);
  stroke-width: 1.25px;
  animation: mg-halo 2.2s ease-out infinite;
}
[data-stage='verifying'] .halo {
  animation: none;
  stroke-opacity: 0.6;
  transform: scale(1.25);
}
/* born */
.is-born .body {
  fill: var(--mg-u-glass-born);
  animation: mg-born 900ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.is-born .glow {
  fill: var(--mg-u-glow-green);
  animation: mg-pulse 1.8s ease-in-out 3;
}
.ripple {
  fill: none;
  stroke: var(--ai-green);
  stroke-width: 1px;
  animation: mg-ripple 1.2s ease-out 1 forwards;
}
/* removing / ghost */
.is-removing .body {
  fill-opacity: calc(0.55 * var(--dp, 1) * var(--mg-dim, 1));
  stroke: var(--ai-faint);
  stroke-dasharray: 2 3;
  stroke-width: 1px;
  transform: scale(0.85);
  transition: transform 900ms var(--mg-ease);
  animation: mg-dim 1.4s ease-in-out infinite alternate;
}
.is-removing .lit,
.is-removing .halo {
  display: none;
}
.is-ghost {
  pointer-events: none;
}
.is-ghost .body {
  fill: none;
  stroke: var(--ai-faint);
  stroke-dasharray: 2 3;
}
.is-ghost > circle,
.is-ghost .body {
  animation: mg-fade 7s linear forwards;
}
/* conflict */
.is-conflict .body {
  fill: var(--mg-u-glass-conflict);
}
.warn {
  fill: none;
  stroke: var(--ai-orange);
  stroke-width: 1px;
}
.warn--in {
  stroke-opacity: 0.75;
}
.warn--out {
  stroke-opacity: 0.35;
}
/* selection */
.selected .body {
  stroke-width: 1.5px;
}
.ring {
  fill: none;
  stroke: var(--ai-accent);
  stroke-opacity: 0.9;
  stroke-width: 1px;
  animation: mg-atmen 2.8s ease-in-out infinite alternate;
}
.pick {
  fill: none;
  stroke: var(--ai-accent);
  stroke-width: 1.5px;
  animation: mg-pick 700ms ease-out forwards;
}
.is-conflict.selected .ring,
.is-conflict.selected .pick {
  stroke: var(--ai-orange);
}
.is-conflict.selected .glow {
  fill: var(--mg-u-glow-orange);
}
/* live link states on nodes */
.link-ring {
  fill: none;
  stroke-width: 1px;
  transition: stroke 400ms var(--mg-ease);
}
.is-recalled .link-ring {
  stroke: var(--ai-accent);
  stroke-opacity: 0.55;
  stroke-dasharray: 2 3;
}
.is-included .link-ring {
  stroke: var(--ai-green);
  stroke-opacity: 0.9;
  stroke-width: 1.25px;
}
.is-written .link-ring {
  stroke: var(--ai-green);
  stroke-opacity: 0.6;
}
.is-updated .link-ring {
  stroke: var(--ai-orange);
  stroke-opacity: 0.65;
}
.is-omitted {
  --mg-dim: 0.5;
}
.is-omitted .body {
  stroke: var(--ai-muted);
  stroke-dasharray: 1.5 2.5;
}
.is-written .body {
  fill: var(--mg-u-glass-born);
}
.flash {
  fill: var(--ai-green);
  animation: mg-flash-fill 900ms ease-out forwards;
}
.is-updated .flash {
  fill: var(--ai-orange);
  animation-duration: 600ms;
}
.burst {
  fill: none;
  stroke: var(--ai-green);
  stroke-width: 1.25px;
  animation: mg-ripple 1.2s ease-out forwards;
}
.pulse {
  fill: none;
  stroke: var(--ai-orange);
  stroke-width: 1.25px;
  animation: mg-ripple 1.1s ease-out forwards;
}
.pulse--b {
  animation-delay: 240ms;
}
.is-deleted {
  pointer-events: none;
}
.is-deleted .body {
  stroke: var(--ai-red);
  animation: mg-decay 1.6s ease-in forwards;
}
.is-deleted .lit,
.is-deleted .halo,
.is-deleted .link-ring {
  display: none;
}
.remnant {
  fill: none;
  stroke: var(--ai-red);
  stroke-opacity: 0.6;
  stroke-width: 1px;
  stroke-dasharray: 2 3;
  animation: mg-remnant 1.6s ease-in both;
}
/* commit wave hitting touched nodes */
.has-wave .is-touched .body {
  animation: mg-wave-hit 500ms ease-out 1;
  animation-delay: calc(var(--wave-f, 0) * 1.6s);
}
/* focus: dim what is neither selected nor adjacent */
.has-selection g[data-node]:not(.selected):not(.is-adjacent):not(.model) {
  --mg-dim: 0.62;
}
.has-selection g[data-node].hub:not(.selected):not(.is-adjacent) {
  --mg-dim: 0.8;
}
.has-selection .edge--stored {
  --mg-dim: 0.55;
}
/* idle: the standing selection does not animate without hover, focus or a dream */
.memory-graph:not(:hover):not(:focus-within):not(.is-dreaming) :is(.ring, .edge-flow),
.is-ambient :is(.ring, .edge-flow) {
  animation-play-state: paused;
}

/* ------------------------------------------------------------------ model core */
.model {
  cursor: pointer;
}
.core-halo {
  fill: var(--ai-accent);
  fill-opacity: 0.38;
  filter: var(--mg-u-blur-core);
  transform-box: fill-box;
  transform-origin: center;
  animation: mg-breathe 6s ease-in-out infinite alternate;
}
.core-ring {
  fill: none;
  stroke: var(--mg-u-ring);
  stroke-width: 2px;
  opacity: 0.22;
  transform-box: fill-box;
  transform-origin: center;
  transition: opacity 600ms var(--mg-ease);
}
.core-body {
  fill: var(--mg-u-glass-lit);
  transform-box: fill-box;
  transform-origin: center;
  animation: mg-breathe 6s ease-in-out infinite alternate;
}
.core-rim {
  fill: none;
  stroke: var(--mg-u-rim);
  stroke-width: 1.5px;
}
.core-spark {
  fill: var(--mg-u-core);
  fill-opacity: 0.85;
  pointer-events: none;
}
.is-thinking .core-halo {
  fill-opacity: 0.5;
  animation: mg-core-pulse 1.5s ease-in-out infinite;
}
.is-thinking .core-body {
  animation: mg-core-pulse 1.5s ease-in-out infinite;
}
.is-thinking .core-ring {
  opacity: 1;
  animation: mg-rotate 2.4s linear infinite;
}
[data-phase='recalling'] .core-ring {
  animation-direction: reverse;
}
[data-phase='answering'] .core-ring {
  animation-duration: 1.6s;
}
.is-dreaming .core-halo {
  fill-opacity: 0.55;
  animation-duration: 3.2s;
}
.is-dreaming .core-ring {
  opacity: 0.7;
  animation: mg-rotate 9s linear infinite;
}
.model .ring {
  stroke-opacity: 0.6;
}

/* ------------------------------------------------------------------ pills, flags */
.pill,
.hover-pill {
  pointer-events: none;
  text-rendering: optimizeLegibility;
}
.pill rect,
.hover-pill rect {
  fill: color-mix(in srgb, var(--ai-surface) var(--mg-pill), transparent);
  stroke: var(--ai-line-strong);
  stroke-width: 1px;
  vector-effect: non-scaling-stroke;
}
.pill text,
.hover-pill text {
  dominant-baseline: middle;
  fill: var(--ai-muted);
  font: 500 10.5px var(--ai-font);
}
.pill--minor rect {
  fill-opacity: var(--dp, 1);
}
.pill--minor text {
  fill-opacity: var(--dp, 1);
}
.pill--hub text,
.pill--model text {
  fill: var(--ai-ink);
  font: 600 11px var(--ai-font);
}
.pill--hub text {
  letter-spacing: 0.08em;
}
.pill-count {
  fill: var(--ai-muted);
  font: 500 10px var(--font-mono);
  letter-spacing: 0;
}
.pill-edge {
  stroke: var(--mg-light);
  stroke-width: 1px;
  opacity: 0.35;
}
.pill-dot {
  fill: var(--mg-u-glass);
}
.pill--model rect {
  stroke: color-mix(in srgb, var(--ai-accent) 45%, var(--ai-line-strong));
}
.selected .pill rect {
  stroke: color-mix(in srgb, var(--ai-accent) 60%, var(--ai-line-strong));
}
.selected .pill text {
  fill: var(--ai-ink);
}
.hover-pill {
  opacity: 0;
  animation: mg-flag-in 160ms var(--mg-ease) forwards;
}
.flag {
  font: 700 8.5px var(--font-mono);
  letter-spacing: 0.1em;
  paint-order: stroke;
  stroke: var(--ai-canvas);
  stroke-width: 2.5px;
  stroke-linejoin: round;
  pointer-events: none;
}
.flag--born {
  fill: var(--ai-green);
  animation: mg-flag-in 300ms var(--mg-ease) both;
}
.flag--conflict {
  fill: var(--ai-orange);
  font-size: 10px;
}

/* ------------------------------------------------------------------ dream light */
.dream-under,
.dream-wave,
.dream-light {
  pointer-events: none;
}
.dream-thread {
  stroke: var(--ai-accent);
  stroke-opacity: 0.45;
  stroke-width: 1;
}
.dream-mote {
  fill: var(--mg-light);
}
.dream-aura {
  fill: var(--mg-u-aura);
  transform-box: fill-box;
  transform-origin: center;
  animation: mg-aura 3.2s ease-in-out infinite alternate;
}
.dream-glow {
  fill: var(--ai-accent);
  fill-opacity: 0.8;
  filter: var(--mg-u-blur);
  transform-box: fill-box;
  transform-origin: center;
  animation: mg-aura 3.2s ease-in-out infinite alternate reverse;
}
.dream-track {
  fill: none;
  stroke: var(--ai-line-strong);
  stroke-width: 1;
}
.dream-progress {
  fill: none;
  stroke: var(--ai-accent);
  stroke-width: 1.5;
  stroke-linecap: round;
  transition:
    stroke-dasharray 600ms var(--mg-ease),
    stroke 400ms var(--mg-ease);
}
.dream-orb {
  fill: var(--mg-u-core);
}
:global(html[data-theme='light'] .memory-graph .dream-orb),
:global(.ai-light .memory-graph .dream-orb) {
  stroke: var(--ai-accent);
  stroke-opacity: 0.5;
  stroke-width: 0.75;
}
[data-stage='verifying'] .dream-progress,
[data-stage='verifying'] .dream-orb {
  stroke: color-mix(in srgb, var(--ai-accent) 55%, var(--ai-green));
  transition-duration: 800ms;
}
[data-stage='failed'] .dream-progress {
  stroke: var(--ai-red);
}
[data-stage='interrupted'] .dream-progress {
  stroke: var(--ai-orange);
}
[data-stage='selecting'] .dream-aura {
  opacity: 0.9;
}
[data-stage='preparing'] .dream-aura {
  opacity: 0.8;
  animation-name: mg-aura-gather;
}
[data-stage='generating'] .dream-aura,
[data-stage='generating'] .dream-glow {
  animation-duration: 2.4s;
}
[data-stage='committing'] .dream-aura,
[data-stage='committing'] .dream-glow {
  animation: mg-flash 700ms ease-out 1;
}
.is-offloading .dream-aura,
.is-offloading .dream-glow {
  animation-duration: 4.4s;
}
.is-offloading {
  --mg-aura: 0.3;
}
.dream-mote-orbit {
  transform-box: fill-box;
  transform-origin: center;
  animation: mg-rotate 7s linear infinite;
}
.dream-mote-orbit--b {
  animation-duration: 11s;
  animation-direction: reverse;
}
.dream-mote-orbit circle {
  fill: var(--mg-light);
  opacity: 0.8;
}
.dream-stage {
  font: 600 8px var(--font-mono);
  letter-spacing: 0.14em;
  fill: var(--ai-muted);
}
.wave-ring {
  fill: none;
  stroke: var(--ai-accent);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  transform-box: fill-box;
  transform-origin: center;
  animation: mg-wave 1.6s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
.wave-ring--b {
  animation-delay: 240ms;
}
.dream-light-enter-active {
  transition: opacity 600ms var(--mg-ease);
}
.dream-light-leave-active {
  transition: opacity 1200ms var(--mg-ease);
}
.dream-light-enter-from,
.dream-light-leave-to {
  opacity: 0;
}

/* ------------------------------------------------------------------ chip, tools, legend */
.memory-graph__dream {
  position: absolute;
  left: 12px;
  top: 12px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 9px;
  border-radius: 999px;
  color: var(--ai-ink);
  font: 500 11px var(--ai-font);
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--ai-surface) 82%, transparent);
  backdrop-filter: blur(12px) saturate(160%);
  border: 1px solid color-mix(in srgb, var(--ai-accent) 40%, transparent);
  box-shadow: inset 0 1px 0 var(--mg-edge);
  background-image: linear-gradient(var(--ai-accent), var(--ai-accent));
  background-repeat: no-repeat;
  background-position: left bottom;
  background-size: calc(var(--mg-progress, 0) * 100%) 2px;
  transition:
    background-size 600ms var(--mg-ease),
    border-color 400ms var(--mg-ease);
}
.memory-graph__dream.is-failed {
  border-color: color-mix(in srgb, var(--ai-red) 50%, transparent);
}
.memory-graph__dream.is-interrupted {
  border-color: color-mix(in srgb, var(--ai-orange) 50%, transparent);
}
.memory-graph__dream-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ai-accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--ai-accent) 60%, transparent);
  animation: mg-dot 1.8s ease-out infinite;
}
.is-offloading .memory-graph__dream-dot {
  animation-duration: 2.8s;
}
.dream-chip-enter-active,
.dream-chip-leave-active {
  transition:
    opacity 400ms var(--mg-ease),
    transform 400ms var(--mg-ease);
}
.dream-chip-enter-from,
.dream-chip-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.memory-graph__tools {
  position: absolute;
  right: 12px;
  top: 12px;
  z-index: 2;
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ai-surface) 82%, transparent);
  backdrop-filter: blur(12px) saturate(160%);
  border: 1px solid var(--ai-line);
  box-shadow: inset 0 1px 0 var(--mg-edge);
}
.memory-graph__tools button {
  min-width: 40px;
  min-height: 40px;
  padding: 4px 12px;
  background: transparent;
  color: var(--ai-ink);
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  font: 500 13px var(--ai-font);
}
.memory-graph__tools button:hover {
  background: var(--ai-hover);
}
.memory-graph__tools button:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: -2px;
}
p {
  padding: 0 16px 12px;
  margin: 0;
  color: var(--ai-muted);
  font-size: 12px;
  position: relative;
  z-index: 1;
}
p span {
  color: var(--ai-faint);
  font-size: 11px;
}

/* ------------------------------------------------------------------ keyframes */
@keyframes mg-aura {
  from {
    transform: scale(1);
  }
  to {
    transform: scale(1.18);
  }
}
@keyframes mg-aura-gather {
  from {
    transform: scale(0.95);
  }
  to {
    transform: scale(0.85);
  }
}
@keyframes mg-rotate {
  to {
    transform: rotate(360deg);
  }
}
@keyframes mg-halo {
  from {
    transform: scale(1);
    stroke-opacity: 0.75;
  }
  to {
    transform: scale(1.7);
    stroke-opacity: 0;
  }
}
@keyframes mg-atmen {
  from {
    transform: scale(1);
  }
  to {
    transform: scale(1.05);
  }
}
@keyframes mg-flow {
  to {
    stroke-dashoffset: -24;
  }
}
@keyframes mg-flow-back {
  to {
    stroke-dashoffset: 20;
  }
}
@keyframes mg-dim {
  from {
    opacity: 1;
  }
  to {
    opacity: 0.45;
  }
}
@keyframes mg-dot {
  to {
    box-shadow: 0 0 0 9px transparent;
  }
}
@keyframes mg-born {
  from {
    transform: scale(0);
  }
  to {
    transform: scale(1);
  }
}
@keyframes mg-ripple {
  from {
    transform: scale(1);
    stroke-opacity: 0.8;
  }
  to {
    transform: scale(3.5);
    stroke-opacity: 0;
  }
}
@keyframes mg-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.9;
  }
}
@keyframes mg-draw {
  from {
    stroke-dashoffset: 1;
  }
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes mg-fade {
  from {
    opacity: 0.9;
  }
  to {
    opacity: 0;
  }
}
@keyframes mg-fade-out {
  to {
    opacity: 0;
  }
}
@keyframes mg-pick {
  from {
    transform: scale(1);
    stroke-opacity: 0.8;
  }
  to {
    transform: scale(3);
    stroke-opacity: 0;
  }
}
@keyframes mg-flash {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  40% {
    transform: scale(1.9);
    opacity: 1.6;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
@keyframes mg-flash-fill {
  from {
    fill-opacity: 0.85;
    transform: scale(0.6);
  }
  to {
    fill-opacity: 0;
    transform: scale(1.6);
  }
}
@keyframes mg-decay {
  from {
    transform: scale(1);
    fill-opacity: 1;
    stroke-opacity: 1;
  }
  to {
    transform: scale(0.25);
    fill-opacity: 0;
    stroke-opacity: 0;
  }
}
@keyframes mg-remnant {
  from {
    stroke-opacity: 0;
    transform: scale(0.6);
  }
  to {
    stroke-opacity: 0.6;
    transform: scale(1);
  }
}
@keyframes mg-wave {
  from {
    transform: scale(1);
    stroke-opacity: 1;
  }
  to {
    transform: scale(23);
    stroke-opacity: 0;
  }
}
@keyframes mg-wave-hit {
  0% {
    stroke-width: 1px;
  }
  50% {
    stroke-width: 2.4px;
  }
  100% {
    stroke-width: 1px;
  }
}
@keyframes mg-flag-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes mg-breathe {
  from {
    transform: scale(1);
  }
  to {
    transform: scale(1.05);
  }
}
@keyframes mg-core-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.12);
  }
}

/* ------------------------------------------------------------------ reduced motion, forced colors */
@media (prefers-reduced-motion: reduce) {
  .memory-graph *,
  .memory-graph::before,
  .memory-graph::after {
    animation: none !important;
  }
  .memory-graph * {
    transition-duration: 160ms !important;
    transition-property: opacity, stroke-opacity, fill-opacity, --mg-dim !important;
  }
  .memory-graph .halo {
    stroke-opacity: 0.6;
  }
  .memory-graph .dream-aura {
    opacity: 0.45;
  }
  .memory-graph .hover-pill {
    opacity: 1;
  }
  .memory-graph .core-ring {
    opacity: 0;
  }
  .memory-graph .is-thinking .core-ring {
    opacity: 0.6;
  }
  .memory-graph .flash,
  .memory-graph .burst,
  .memory-graph .pulse,
  .memory-graph .pick,
  .memory-graph .ripple {
    display: none;
  }
  .memory-graph .is-deleted .body {
    fill-opacity: 0;
  }
}
@media (forced-colors: active) {
  .mist,
  .floor,
  .glow,
  .core-halo,
  .dream-aura,
  .dream-glow {
    display: none;
  }
  .body,
  .core-body {
    fill: CanvasText;
    stroke: Canvas;
  }
  .edge,
  .link {
    stroke: CanvasText;
  }
  .edge--selected {
    stroke: Highlight;
  }
  .pill rect,
  .hover-pill rect {
    fill: Canvas;
    stroke: CanvasText;
  }
  .pill text,
  .hover-pill text,
  .flag {
    fill: CanvasText;
  }
  .dream-orb {
    fill: Highlight;
  }
}
</style>
