import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VITE_BASE — путь на GitHub Pages; тестовый контур собирается в /gymbot-miniapp/staging/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/gymbot-miniapp/',
})
