import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from '@unocss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), UnoCSS()],
  server: {
    host: '127.0.0.1',
    port: 42763,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 42763,
    strictPort: true,
  },
})
