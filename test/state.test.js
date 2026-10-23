import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyState, transition, digestOf } from '../src/state.js'
import { proposal } from './helpers.js'

function study(mode = 'general', version = 1) {
  let state = emptyState(), seq = 0
  const update = command => {
    state = transition(state, { version, requestId: `r${seq}`, expectedRevision: state.revision,
      digest: digestOf(command), command }, ++seq)
    return state
  }
  update({ action: 'propose', proposal: { ...proposal, mode, protocol: mode === 'quantitative' ? 'data=sha256:abc; split=causal; costs=10bps; metric=net_return' : '' } })
  update({ action: 'confirm', user: { seq: 2, quote: '确认方案' } })
  return { state: () => state, update }
}
const measurement = { id: 'm1', kind: 'measurement', claim: '测试集净收益', sourceSeq: 10, quote: 'return=0.01', ref: '' }

test('plan progress moves independently of validation results and can reopen without duplicating the node', () => {
  const h = study('general', 2)
  const node = { id: 'plan-a', title: '比较候选策略', parents: [], evidenceIds: [], status: 'open', note: '等待固定数据。' }
  h.update({ action: 'node', node })
  assert.deepEqual(h.state().nodes[0], node)
  for (const stage of ['planned', 'active', 'blocked', 'completed', 'active']) {
    h.update({ action: 'node_update', id: node.id, progress: { stage, summary: '完成小样本比较，仍需核查长尾。', nextStep: stage === 'completed' ? '' : '补充长尾查询。' } })
    assert.equal(h.state().nodes.length, 1)
    assert.equal(h.state().nodes[0].progress.stage, stage)
    assert.equal(h.state().nodes[0].status, 'open')
    assert.deepEqual(h.state().nodes[0].parents, [])
  }
  h.update({ action: 'evidence', evidence: measurement })
  h.update({ action: 'node_update', id: node.id, progress: { stage: 'completed', summary: '本次验证发现反例，保留负结果。', nextStep: '' }, status: 'refuted', evidenceIds: ['m1'], note: '固定数据已保存。' })
  assert.equal(h.state().nodes[0].status, 'refuted')
  assert.equal(h.state().nodes[0].progress.stage, 'completed')
  assert.equal(h.state().nodes[0].title, node.title)
})

test('plan updates reject missing nodes, invented evidence and invalid progress without changing history', () => {
  const h = study('general', 2)
  h.update({ action: 'node', node: { id: 'n1', title: '候选方案', parents: [], evidenceIds: [], status: 'open', note: '待验证。' } })
  const before = h.state(), command = { action: 'node_update', id: 'n1', progress: { stage: 'active', summary: '固定测试输入。', nextStep: '运行对照实验。' } }
  for (const change of [
    { ...command, id: 'missing' }, { ...command, evidenceIds: ['invented'] }, { ...command, status: 'supported' },
    { ...command, progress: { ...command.progress, stage: 'blocked', nextStep: '' } },
    { ...command, progress: { ...command.progress, summary: '长'.repeat(401) } },
    { ...command, progress: { ...command.progress, stage: 'pretend', percent: 95 } },
  ]) assert.throws(() => h.update(change))
  assert.deepEqual(h.state(), before)
  h.update({ action: 'stop', reason: '暂停' })
  assert.throws(() => h.update(command), /confirmed and running/)
})

test('historical v2 report replay remains valid without the new model summary field', () => {
  const h = study()
  h.update({ action: 'evidence', evidence: measurement })
  const before = h.state(), command = { action: 'report', report: { text: '历史报告 m1', evidenceIds: ['m1'], limits: '仅固定样本' } }
  const restored = transition(before, { version: 2, requestId: 'old-report', expectedRevision: before.revision, digest: digestOf(command), command }, 100)
  assert.deepEqual(restored.report, command.report)
  assert.equal(Object.hasOwn(restored.report, 'summary'), false)
})

test('quantitative studies freeze the evaluation protocol and require measured evidence for completed experiments', () => {
  const h = study('quantitative')
  const experiment = { id: 'run1', method: 'python compare.py', input: 'data hash abc; seed 42',
    protocol: h.state().proposal.protocol, baseline: 'return=0.005', candidate: 'return=0.01', metrics: 'net_return; test only',
    status: 'completed', evidenceIds: ['m1'], limits: 'one fixed holdout' }
  assert.throws(() => h.update({ action: 'experiment', experiment }), /does not exist/)
  h.update({ action: 'evidence', evidence: measurement })
  assert.throws(() => h.update({ action: 'experiment', experiment: { ...experiment, protocol: 'changed split' } }), /protocol is frozen/)
  h.update({ action: 'experiment', experiment })
  assert.equal(h.state().experiments[0].protocol, h.state().proposal.protocol)
  assert.throws(() => study('quantitative').update({ action: 'experiment', experiment }), /does not exist/)
})

test('missing quantitative protocol and unsupported command fields are rejected', () => {
  const state = emptyState()
  const command = { action: 'propose', proposal: { ...proposal, mode: 'quantitative', protocol: '' } }
  assert.throws(() => transition(state, { version: 1, requestId: 'invalid', digest: digestOf(command), expectedRevision: 0, command }, 0), /protocol/)
  assert.throws(() => transition(state, { version: 1, requestId: 'invalid', digest: 'none', expectedRevision: 0,
    command: { action: 'stop', reason: 'stop', execute: 'injected' } }, 0), /Unrecognized key/)
})

test('unsettled operations block reports and explicit resume marks uncertain work without deleting evidence', () => {
  const h = study()
  h.update({ action: 'evidence', evidence: measurement })
  h.update({ action: 'begin', operation: { id: 'op1', tool: 'bash' } })
  const report = { text: 'Limited result m1', evidenceIds: ['m1'], limits: 'unknown command outcome' }
  assert.throws(() => h.update({ action: 'report', report }), /Unsettled/)
  h.update({ action: 'stop', reason: 'interrupted' })
  assert.throws(() => h.update({ action: 'resume', user: { seq: 2, quote: '继续研究' } }), /new user instruction/)
  h.update({ action: 'resume', user: { seq: 999, quote: '继续研究' } })
  assert.equal(h.state().operations[0].status, 'unknown')
  h.update({ action: 'report', report })
  assert.equal(h.state().evidence.length, 1)
  assert.equal(h.state().report.limits, 'unknown command outcome')
})

test('limits reject large multibyte input, duplicate edges, and too many sources without altering state', () => {
  const h = study()
  assert.throws(() => h.update({ action: 'evidence', evidence: { ...measurement, quote: '中'.repeat(6001) } }), /Too big/)
  h.update({ action: 'evidence', evidence: measurement })
  assert.throws(() => h.update({ action: 'node', node: { id: 'n1', title: 'node', parents: [], evidenceIds: ['m1', 'm1'], status: 'supported', note: 'two refs' } }), /Duplicate references/)
  for (let i = 2; i <= 64; i++) h.update({ action: 'evidence', evidence: { ...measurement, id: `m${i}` } })
  assert.throws(() => h.update({ action: 'evidence', evidence: { ...measurement, id: 'm65' } }), /limit reached/)
  assert.equal(h.state().evidence.length, 64)
})

test('the complete working state is bounded in UTF-8 bytes', () => {
  const h = study()
  let rejected = false
  for (let i = 0; i < 20; i++) {
    const previous = h.state()
    try { h.update({ action: 'evidence', evidence: { ...measurement, id: `wide${i}`, claim: '中'.repeat(4000), quote: '文'.repeat(6000) } }) }
    catch (error) {
      assert.match(error.message, /exceeds 256 KB/)
      assert.equal(h.state(), previous)
      rejected = true
      break
    }
  }
  assert.equal(rejected, true)
  assert.ok(Buffer.byteLength(JSON.stringify(h.state()), 'utf8') <= 256000)
})
