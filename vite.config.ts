import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import packageJson from './package.json'

// https://vite.dev/config/
export default defineConfig({
    base: '/sql-converter/',
    define: {
        __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
})
