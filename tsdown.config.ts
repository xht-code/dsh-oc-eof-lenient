import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { defineConfig } from 'tsdown'

/**
 * DSH checkout is the development source of the host contracts and runtime
 * packages. The aliases let tsdown type-check against that checkout while the
 * generated package keeps those packages as runtime peer imports.
 */
const envFile = resolve(process.cwd(), '.env')
if (existsSync(envFile)) loadEnvFile(envFile)

const checkout = process.env.DSH_CHECKOUT?.trim()
if (checkout === undefined) {
  throw new Error('DSH_CHECKOUT is required when building dsh-oc-eof-lenient')
}

const checkoutRoot = resolve(checkout)
if (!existsSync(resolve(checkoutRoot, 'packages'))) {
  throw new Error(`DSH_CHECKOUT=${checkoutRoot} is not a DSH checkout (missing packages/)`)
}

const alias = {
  '@deepseek-ai/cordis': resolve(checkoutRoot, 'vendor/cordis/src/index.ts'),
  '@deepseek-ai/cosmokit': resolve(checkoutRoot, 'vendor/cosmokit/src/index.ts'),
  '@deepseek-ai/schemastery': resolve(checkoutRoot, 'vendor/schemastery/src/index.ts'),
  '@deepseek-ai/dsh-llm': resolve(checkoutRoot, 'packages/llm/llm/src/index.ts'),
  '@deepseek-ai/dsh-settings': resolve(checkoutRoot, 'packages/settings/settings/src/index.ts'),
}

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  alias,
  // Resolve against DSH source for checking, but preserve every host package
  // as an external import in the published plugin.
  deps: { neverBundle: Object.keys(alias) },
})
