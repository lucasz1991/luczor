import tailwind from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'
import { version as pkgVersion } from './package.json'
import { DEFAULT_API_BASE_URL, DEV_API_PREFIX } from './src/services/api/endpoint'

const HOST = process.env.TAURI_DEV_HOST
const PLATFORM = process.env.TAURI_ENV_PLATFORM
process.env.VITE_APP_VERSION = pkgVersion
if (process.env.NODE_ENV === 'production') {
  process.env.VITE_APP_BUILD_EPOCH = new Date().getTime().toString()
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    tailwind(),
    vue(),
    vueDevTools(),
    AutoImport({
      imports: [
        'vue',
        'vue-router',
        'pinia',
        {
          '@/store': ['useStore'],
        },
      ],
      dts: 'auto-imports.d.ts',
      vueTemplate: true,
    }),
    Components({
      dts: 'components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorMaxWorkers: true,
  },

  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  server: {
    port: 1420,
    strictPort: true,
    host: HOST || false,
    // The packaged WebView uses its server-approved Tauri origin. Vite relays
    // only the fixed Luczor API so localhost development needs no production CORS expansion.
    proxy: {
      [`^${DEV_API_PREFIX}/api/v1(?:/|\\?|$)`]: {
        target: DEFAULT_API_BASE_URL,
        changeOrigin: true,
        secure: true,
        followRedirects: false,
        ws: false,
        rewrite: path => path.slice(DEV_API_PREFIX.length),
        configure: proxy => {
          // This API authenticates with the explicit device bearer, never a localhost browser cookie.
          proxy.on('proxyReq', request => request.removeHeader('cookie'))
          proxy.on('proxyRes', response => {
            delete response.headers['set-cookie']
          })
        },
      },
    },
    hmr: HOST
      ? {
          protocol: 'ws',
          host: HOST,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: './dist',
    // See https://web-platform-dx.github.io/web-features/ for Vite 8 default targets (baseline-widely-available)
    // See https://v2.tauri.app/reference/webview-versions/ for Tauri details
    target: PLATFORM == 'windows' ? 'chrome111' : 'safari16.4',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    emptyOutDir: true,
    chunkSizeWarningLimit: 1024,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
