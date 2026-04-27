import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
    base: '/sql-converter/',
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
})
