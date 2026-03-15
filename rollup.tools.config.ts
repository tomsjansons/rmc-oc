import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import { glob } from 'glob'
import path from 'node:path'

const toolFiles = glob
  .sync('src/opencode/tool/*.ts')
  .filter((file) => !file.endsWith('.d.ts'))
const input = Object.fromEntries(
  toolFiles.map((file) => [path.basename(file, '.ts'), file])
)

const config = {
  input,
  output: {
    dir: 'dist/.opencode/tool',
    format: 'es',
    entryFileNames: '[name].js',
    sourcemap: false
  },
  plugins: [
    typescript({
      compilerOptions: {
        outDir: 'dist/.opencode/tool',
        rootDir: undefined
      }
    }),
    nodeResolve({ preferBuiltins: true }),
    commonjs()
  ],
  external: ['@opencode-ai/plugin']
}

export default config
