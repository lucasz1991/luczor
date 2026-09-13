<script setup lang="ts">
import { computed } from 'vue'
import { ACCENT_NAMES, type HudPosition, type ThemeName } from '@/services/appearance'

const props = defineProps<{
  assistantName: string
  accent: string
  theme: ThemeName
  hudPosition: HudPosition
  uiScale: number
  hudVisible: boolean
  showGrid: boolean
  reduceMotion: boolean
}>()

const emit = defineEmits<{
  (event: 'update:assistantName', value: string): void
  (event: 'update:accent', value: string): void
  (event: 'update:theme', value: ThemeName): void
  (event: 'update:hudPosition', value: HudPosition): void
  (event: 'update:uiScale', value: number): void
  (event: 'update:hudVisible', value: boolean): void
  (event: 'update:showGrid', value: boolean): void
  (event: 'update:reduceMotion', value: boolean): void
}>()

const assistantNameModel = computed({
  get: () => props.assistantName,
  set: value => emit('update:assistantName', value),
})
const hudPositionModel = computed({
  get: () => props.hudPosition,
  set: value => emit('update:hudPosition', value),
})
const uiScaleModel = computed({
  get: () => props.uiScale,
  set: value => emit('update:uiScale', value),
})

const THEME_OPTIONS: Array<{ value: ThemeName; label: string; hint: string }> = [
  { value: 'dark', label: 'Dunkel', hint: 'Obsidian-Glas' },
  { value: 'light', label: 'Hell', hint: 'Milchglas' },
  { value: 'system', label: 'System', hint: 'folgt Windows' },
]

function accentColor(name: string): string {
  switch (name) {
    case 'emerald':
      return '#34d399'
    case 'violet':
      return '#a78bfa'
    case 'amber':
      return '#fbbf24'
    case 'rose':
      return '#fb7185'
    default:
      return '#38bdf8'
  }
}
</script>

<template>
  <div class="lz-section">
    <div class="lz-section__head">
      <h3>Personalisierung</h3>
      <p>Name, Akzentfarbe, HUD und Darstellung. Wird beim Speichern übernommen.</p>
    </div>
    <div class="lz-card">
      <label class="lz-label">Assistenten-Name</label>
      <input v-model="assistantNameModel" class="lz-input" placeholder="Luczor" />

      <label class="lz-label" style="margin-top: 6px">Erscheinungsbild</label>
      <div class="lz-segment" role="radiogroup" aria-label="Erscheinungsbild">
        <button
          v-for="option in THEME_OPTIONS"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="theme === option.value"
          class="lz-segment__item"
          :class="{ 'is-active': theme === option.value }"
          @click="emit('update:theme', option.value)"
        >
          <span>{{ option.label }}</span>
          <small>{{ option.hint }}</small>
        </button>
      </div>
      <p class="lz-hint">Wird auf diesem Gerät gespeichert und beim nächsten Start wieder verwendet.</p>

      <label class="lz-label" style="margin-top: 6px">Akzentfarbe</label>
      <div class="lz-swatches">
        <button
          v-for="name in ACCENT_NAMES"
          :key="name"
          type="button"
          class="lz-swatch"
          :class="{ 'is-active': accent === name }"
          :style="{ background: accentColor(name) }"
          :title="name"
          @click="emit('update:accent', name)"
        />
      </div>

      <div class="lz-grid2">
        <div>
          <label class="lz-label">HUD-Position</label>
          <select v-model="hudPositionModel" class="lz-input">
            <option value="br">Unten rechts</option>
            <option value="bl">Unten links</option>
            <option value="tr">Oben rechts</option>
            <option value="tl">Oben links</option>
          </select>
        </div>
        <div>
          <label class="lz-label">UI-Skalierung</label>
          <div class="lz-range">
            <input v-model.number="uiScaleModel" type="range" min="0.8" max="1.4" step="0.05" />
            <span class="lz-range__val">{{ Math.round(uiScale * 100) }}%</span>
          </div>
        </div>
      </div>

      <div v-if="false" class="lz-row">
        <span class="lz-rowlabel">HUD anzeigen</span>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': hudVisible }"
          @click="emit('update:hudVisible', !hudVisible)"
        >
          <span />
        </button>
      </div>
      <div class="lz-row">
        <span class="lz-rowlabel">Hintergrund-Grid</span>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': showGrid }"
          @click="emit('update:showGrid', !showGrid)"
        >
          <span />
        </button>
      </div>
      <div class="lz-row">
        <span class="lz-rowlabel">Animationen reduzieren</span>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': reduceMotion }"
          @click="emit('update:reduceMotion', !reduceMotion)"
        >
          <span />
        </button>
      </div>
    </div>
  </div>
</template>
