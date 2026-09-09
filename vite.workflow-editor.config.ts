import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: '../.lmzdev/artifacts/runtime/workflow-editor',
    emptyOutDir: true,
    manifest: 'manifest.json',
    target: 'chrome111',
    rollupOptions: {
      input: 'src/workflow-editor-web.ts',
      output: {
        entryFileNames: 'editor-[hash].js',
        chunkFileNames: 'chunk-[hash].js',
        assetFileNames: 'editor-[hash][extname]',
      },
    },
  },
})
