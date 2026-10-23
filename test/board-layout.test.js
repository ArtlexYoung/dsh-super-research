import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let client
vm.runInNewContext(await readFile(new URL('../client/index.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { client = factory(() => ({})) } } },
})
const layout = nodes => JSON.parse(JSON.stringify(client.boardLayout(nodes)))
const card = (id, stage, parents = []) => ({ id, parents, title: id, status: 'supported', evidenceIds: ['e1'], note: '已有依据。',
  ...(stage ? { progress: { stage, summary: '验证进展。', nextStep: stage === 'completed' ? '' : '补充样本。' } } : {}) })

test('board groups explicit progress while retaining dependencies and separating historical outcomes', () => {
  const nodes = [card('a', 'planned'), card('b', 'active', ['a']), card('c', 'blocked', ['a']), card('d', 'completed', ['b']), card('old')]
  const board = layout(nodes)
  assert.deepEqual(board.lanes.map(lane => lane.stage), ['planned', 'active', 'blocked', 'completed', 'untracked'])
  assert.equal(board.completed, 1)
  assert.equal(board.tracked, 4)
  for (const node of nodes) {
    const position = board.positions.find(item => item.id === node.id), lane = board.lanes.find(item => item.stage === (node.progress?.stage || 'untracked'))
    assert.deepEqual(position.parents, node.parents)
    assert.ok(position.x >= lane.x && position.x + 260 <= lane.x + lane.width)
    assert.ok(position.y + 204 < board.height)
  }
  assert.equal(board.positions.find(node => node.id === 'old').stage, 'untracked')
  const moved = layout(nodes.map(node => node.id === 'b' ? { ...node, progress: { ...node.progress, stage: 'completed' } } : node))
  assert.equal(moved.completed, 2)
  assert.equal(moved.positions.find(node => node.id === 'b').stage, 'completed')
  assert.equal(nodes[1].progress.stage, 'active')
})

test('legacy and large boards never invent completion or overlap their cards; empty layout stays finite', () => {
  for (const count of [0, 10, 5000]) {
    const board = layout(Array.from({ length: count }, (_, i) => card(`old-${i}`)))
    assert.equal(board.completed, 0); assert.equal(board.tracked, 0)
    assert.equal(board.positions.length, count)
    assert.equal(new Set(board.positions.map(item => `${item.x}/${item.y}`)).size, count)
    assert.ok(Number.isFinite(board.width) && Number.isFinite(board.height))
  }
})
