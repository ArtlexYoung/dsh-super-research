import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

for (const root of ['src', 'client', 'test', 'scripts']) {
  for (const file of await readdir(root, { recursive: true })) {
    if (/\.[cm]?js$/.test(file)) execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' })
  }
}
console.log('JavaScript syntax checks passed.')
