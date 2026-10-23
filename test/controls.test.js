import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { host, plain, proposal } from './helpers.js'
import { configurationSchema } from '../src/config.js'
import { emptyState, transition, digestOf } from '../src/state.js'
import { researchProjection } from '../src/projection.js'

async function ok(pending) { const result = await pending; assert.equal(result.isError, false, plain(result)); return result }
const unlimited = { maxToolCalls: 0, maxEvidence: 0, maxNodes: 0, maxExperiments: 0 }
const evidence = { id: 'e1', kind: 'supplied', claim: '用户材料待验证', sourceSeq: 1, quote: '材料', ref: '' }

test('live plan progress persists and exports with stable identity, idempotence and no extra node budget', async t => {
  const h = await host(t, { configuration: { maxNodes: 1 } })
  await ok(h.propose()); await ok(h.confirm())
  await ok(h.record({ action: 'node', node: { id: 'plan-a', title: '比较候选方案', parents: [], evidenceIds: [], status: 'open', note: '固定输入再比较。' } }))
  const revision = h.state().revision
  const command = { action: 'node_update', id: 'plan-a', progress: { stage: 'blocked', summary: '缺少独立测试集，不能判断泛化效果。', nextStep: '补充独立测试集后继续验证。' } }
  const args = { requestId: 'plan-progress-1', expectedRevision: revision }
  await ok(h.record(command, args)); await ok(h.record(command, args))
  assert.equal(h.state().revision, revision + 1)
  assert.equal(h.state().nodes.length, 1)
  assert.deepEqual(h.state().nodes[0].progress, command.progress)
  const exported = JSON.parse(await readFile(`${h.state().workspace.directory}/exploration.json`, 'utf8'))
  assert.deepEqual(exported[0].progress, command.progress)
  const conflicting = await h.record({ ...command, progress: { ...command.progress, stage: 'active' } }, args)
  assert.equal(conflicting.isError, true)
  const read = JSON.parse(plain(await ok(h.call({ action: 'read' }))))
  assert.deepEqual(read.nodes[0].progress, command.progress)
  let replayed = emptyState()
  for (const event of h.session.snapshotEvents()) replayed = researchProjection.apply(replayed, event)
  assert.deepEqual(replayed, h.state())
})

test('natural confirmation and report improvements execute in one step, preserving the previous report', async t => {
  const h = await host(t)
  await ok(h.propose())
  const approval = h.user('好，按这个方案开始，优先检查边界情况。')
  await ok(h.record({ action: 'confirm', user: { seq: approval.seq, quote: approval.data.content[0].text } }))
  const material = h.user('材料')
  await ok(h.record({ action: 'evidence', evidence: { ...evidence, sourceSeq: material.seq } }))
  const report = { summary: '尚需验证假设，当前材料不能形成最终结论。', text: '初稿 [e1]', evidenceIds: ['e1'], limits: '需要验证' }
  const revision = h.state().revision
  const { summary, ...withoutSummary } = report
  const missing = await h.record({ action: 'report', report: withoutSummary })
  assert.equal(missing.isError, true)
  assert.match(plain(missing), /model-written summary/)
  const oversized = await h.record({ action: 'report', report: { ...report, summary: '长'.repeat(401) } })
  assert.equal(oversized.isError, true)
  assert.equal(h.state().revision, revision)
  await ok(h.record({ action: 'report', report }))
  const revise = h.user('能再深入一点，补充反例并完善报告吗？')
  await ok(h.record({ action: 'review', decision: 'revise', user: { seq: revise.seq, quote: revise.data.content[0].text } }))
  assert.equal(h.state().status, 'running')
  assert.deepEqual(h.state().report, report)
  await ok(h.call({}, 'fixture_measure'))
  await ok(h.record({ action: 'report', report: { ...report, text: '修订稿 [e1]' } }))
  const improve = h.user('不要只是回复状态，修改报告并补充实验。')
  await ok(h.record({ action: 'resume', user: { seq: improve.seq, quote: improve.data.content[0].text } }))
  assert.equal(h.state().status, 'running')
  await ok(h.call({}, 'fixture_measure'))
  assert.equal(h.calls(), 2)
})

test('limits can be raised on an exhausted existing study and applied without moving artifacts or clearing history', async t => {
  const h = await host(t, { maxToolCalls: 1 })
  await ok(h.propose()); await ok(h.confirm()); await ok(h.call({}, 'fixture_measure'))
  const directory = h.state().workspace.directory
  const event = h.user('所有上限改为无限制，并继续研究。')
  await ok(h.record({ action: 'limits', limits: unlimited, user: { seq: event.seq, quote: event.data.content[0].text } }))
  assert.equal(h.state().proposal.maxToolCalls, 0)
  assert.equal(h.state().workspace.directory, directory)
  await ok(h.call({}, 'fixture_measure'))
  assert.equal(h.state().operations.length, 2)
  const read = JSON.parse(plain(await ok(h.call({ action: 'read' }))))
  assert.equal(read.settings.maxToolCalls, 0)
  assert.equal(read.configuredSettings.maxToolCalls, 40)
})

test('unlimited host dispatch and limits plus resume use the same user instruction', async t => {
  const h = await host(t, { maxToolCalls: 0, configuration: unlimited })
  await ok(h.propose()); await ok(h.confirm()); await ok(h.call({}, 'fixture_measure'))
  await ok(h.record({ action: 'stop', reason: 'pause' }))
  const event = h.user('预算调大到一百万，然后继续验证。')
  const user = { seq: event.seq, quote: event.data.content[0].text }
  await ok(h.record({ action: 'limits', limits: { ...unlimited, maxToolCalls: 1000000 }, user }))
  await ok(h.record({ action: 'resume', user }))
  await ok(h.call({}, 'fixture_measure'))
  assert.equal(h.calls(), 2)
  assert.equal(h.state().proposal.maxToolCalls, 1000000)
})

test('refusal, stale instructions and fabricated authorization cannot reopen a report', async t => {
  const h = await host(t)
  await ok(h.propose()); await ok(h.confirm())
  await ok(h.record({ action: 'stop', reason: 'paused' }))
  const old = h.user('再深入研究一下')
  const latest = h.user('不要继续研究，先讨论结论')
  for (const user of [{ seq: old.seq, quote: old.data.content[0].text }, { seq: latest.seq, quote: latest.data.content[0].text }, { seq: latest.seq, quote: '继续研究' }]) {
    const result = await h.record({ action: 'resume', user })
    assert.equal(result.isError, true)
  }
  assert.equal(h.state().status, 'stopped')
  assert.equal(h.calls(), 0)
})

test('v2 unlimited studies cross old operation, request, evidence, node, experiment and byte ceilings', () => {
  let state = emptyState(), seq = 0
  const update = command => {
    const record = { version: 2, requestId: `new${seq}`, expectedRevision: state.revision, digest: digestOf(command), command }
    state = transition(state, record, ++seq)
  }
  update({ action: 'propose', proposal: { ...proposal, maxToolCalls: 0 }, workspace: { project: '/project', directory: '/project/.super-research/study', relativeDirectory: '.super-research/study', settings: configurationSchema.parse(unlimited) } })
  update({ action: 'confirm', user: { seq: 2, quote: '开始研究' } })
  for (let i = 0; i < 260; i++) {
    update({ action: 'begin', operation: { id: `op${i}`, tool: 'fixture' } })
    update({ action: 'settle', id: `op${i}`, outcome: 'completed' })
  }
  for (let i = 0; i < 80; i++) update({ action: 'evidence', evidence: { ...evidence, id: `e${i}`, quote: '中'.repeat(1200) } })
  for (let i = 0; i < 60; i++) update({ action: 'node', node: { id: `n${i}`, title: '假设', parents: [], evidenceIds: ['e1'], status: 'open', note: '待验证' } })
  for (let i = 0; i < 30; i++) update({ action: 'experiment', experiment: { id: `x${i}`, method: 'compare', input: 'fixture', protocol: 'fixed', baseline: 'reference', candidate: 'candidate', metrics: 'pending', status: 'inconclusive', evidenceIds: ['e1'], limits: 'pending' } })
  assert.equal(state.operations.length, 260)
  assert.ok(state.requests.length > 512)
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 256000)
  assert.equal(state.experiments.length, 30)
  assert.equal(state.nodes.length, 60)
  assert.equal(state.evidence.length, 80)
})

test('all count settings accept large safe integers and unlimited, and reject invalid numbers', () => {
  for (const value of [0, 1000000000, Number.MAX_SAFE_INTEGER]) {
    const settings = configurationSchema.parse(Object.fromEntries(Object.keys(unlimited).map(key => [key, value])))
    assert.equal(settings.maxExperiments, value)
  }
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => configurationSchema.parse({ maxToolCalls: value }))
})

test('original v1 report/revise snapshots retain their hashes and paused semantics', async () => {
  const events = JSON.parse(await readFile(new URL('./fixtures/v1-report.json', import.meta.url), 'utf8'))
  let state = emptyState()
  for (const event of events) {
    state = researchProjection.apply(state, event)
    assert.notEqual(state.status, 'invalid')
    assert.equal(digestOf(state), digestOf(event.data.state))
  }
  assert.equal(state.status, 'stopped')
  assert.equal(state.report.text, 'original report [e1]')
})
