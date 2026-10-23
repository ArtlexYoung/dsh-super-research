import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let client
vm.runInNewContext(await readFile(new URL('../client/index.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { client = factory(() => ({})) } } },
})

test('long goals stay concise and plain while report conclusions are supplied by the model', () => {
  assert.equal(client.briefText('比较策略 A 与 B。核查反例。记录全部实验。'), '比较策略 A 与 B。 核查反例。')
  assert.equal(client.briefText('目标'.repeat(500), 120).length, 121)
  assert.equal(client.briefText('目标'.repeat(500), 120).endsWith('…'), true)
  assert.equal(client.briefText('<script>unsafe()</script>[结果](https://example.org) 不能推广。'), '结果 不能推广。')
})
