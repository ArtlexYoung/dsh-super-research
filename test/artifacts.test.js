import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { agentIn, host, plain, proposal } from './helpers.js'
import { ResearchStore } from '../src/store.js'
import { DEFAULTS, configurationSchema } from '../src/config.js'
import { digestOf, emptyState, RECORD_TYPE, transition } from '../src/state.js'

async function ok(result) { const value = await result; assert.equal(value.isError, false, plain(value)); return value }
async function denied(result, pattern) { const value = await result; assert.equal(value.isError, true, plain(value)); assert.match(plain(value), pattern); return value }
const signal = () => new AbortController().signal

test('all generated views and reports stay in a session directory and leave Git status unchanged', async t => {
  const h = await host(t)
  await writeFile(join(h.directory, 'source.txt'), 'source stays untouched')
  execFileSync('git', ['init', '--quiet', h.directory])
  const status = () => execFileSync('git', ['-C', h.directory, 'status', '--porcelain'], { encoding: 'utf8' })
  const before = status()
  await ok(h.propose()); await ok(h.confirm())
  const event = h.user('supplied source: stable ordering')
  await ok(h.record({ action: 'evidence', evidence: { id: 'e1', kind: 'supplied', claim: '用户材料', sourceSeq: event.seq, quote: 'stable ordering', ref: '' } }))
  await ok(h.record({ action: 'node', node: { id: 'n1', title: '顺序假设', parents: [], evidenceIds: ['e1'], status: 'open', note: '需要测量' } }))
  await ok(h.record({ action: 'experiment', experiment: { id: 'x1', method: 'compare', input: 'user material', protocol: 'fixed input', baseline: 'reference', candidate: 'candidate', metrics: 'pending', status: 'inconclusive', evidenceIds: ['e1'], limits: '尚未测量' } }))
  await ok(h.record({ action: 'report', report: { summary: '当前仅有有限证据，尚不能推广结论。', text: '用户材料支持待验证假设 [e1]。', evidenceIds: ['e1'], limits: '未执行实验。' } }))
  const state = h.state(), directory = state.workspace.directory
  assert.ok(directory.startsWith(join(h.directory, '.super-research', 'study-')))
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'study.json'), 'utf8')), state)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')), state.evidence)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'exploration.json'), 'utf8')), state.nodes)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'experiments.json'), 'utf8')), state.experiments)
  assert.match(await readFile(join(directory, 'report.md'), 'utf8'), /未执行实验/)
  assert.match(await readFile(join(directory, 'report.md'), 'utf8'), /## 总结\n\n当前仅有有限证据，尚不能推广结论。/)
  assert.match(await readFile(join(directory, 'proposal.md'), 'utf8'), /排序策略比较/)
  assert.deepEqual((await readdir(h.directory)).sort(), ['.git', '.super-research', 'source.txt'])
  assert.equal(status(), before)
  execFileSync('git', ['-C', h.directory, 'check-ignore', '--quiet', '.super-research/.gitignore'])
  assert.equal(await readFile(join(h.directory, 'source.txt'), 'utf8'), 'source stays untouched')
})

test('settings and the original project are frozen; a new session uses updated settings', async t => {
  const h = await host(t)
  await ok(h.propose())
  const frozen = structuredClone(h.state().workspace)
  h.ctx.superResearchConfiguration.read = () => ({ ...DEFAULTS, outputDirectory: '.studies', maxToolCalls: 2 })
  const nested = join(h.directory, 'nested'); await mkdir(nested)
  h.session.append('working-directory/change', { cwd: nested })
  await ok(h.call({ action: 'read' }))
  assert.deepEqual(h.state().workspace, frozen)
  const other = h.ctx.sessions.create(SessionId('new-study'), { meta: { cwd: h.directory } })
  const owner = agentIn(h.ctx, other)
  t.after(() => owner.scope.dispose())
  const store = new ResearchStore(h.ctx)
  await store.write(other, signal(), { requestId: 'new', expectedRevision: 0, command: { action: 'propose', proposal: { ...proposal, maxToolCalls: 2 } } })
  const second = store.current(other).workspace
  assert.equal(second.settings.maxToolCalls, 2)
  assert.ok(second.directory.startsWith(join(h.directory, '.studies')))
  assert.notEqual(second.directory, frozen.directory)
})

test('configured tool, evidence, node and experiment limits are enforced at the write boundary', async t => {
  const h = await host(t, { maxToolCalls: 1, configuration: { maxToolCalls: 1, maxEvidence: 1, maxNodes: 1, maxExperiments: 1 } })
  await denied(h.record({ action: 'propose', proposal }), /configured research tool budget/)
  assert.equal(h.state().revision, 0)
  await ok(h.propose()); await ok(h.confirm())
  const event = h.user('source')
  const evidence = { id: 'e1', kind: 'supplied', claim: 'source', sourceSeq: event.seq, quote: 'source', ref: '' }
  await ok(h.record({ action: 'evidence', evidence }))
  await denied(h.record({ action: 'evidence', evidence: { ...evidence, id: 'e2' } }), /limit reached/)
  const node = { id: 'n1', title: 'hypothesis', parents: [], evidenceIds: ['e1'], status: 'open', note: 'pending' }
  await ok(h.record({ action: 'node', node }))
  await denied(h.record({ action: 'node', node: { ...node, id: 'n2' } }), /limit reached/)
  const experiment = { id: 'x1', method: 'compare', input: 'source', protocol: 'fixed', baseline: 'reference', candidate: 'candidate', metrics: 'pending', status: 'inconclusive', evidenceIds: ['e1'], limits: 'pending' }
  await ok(h.record({ action: 'experiment', experiment }))
  await denied(h.record({ action: 'experiment', experiment: { ...experiment, id: 'x2' } }), /limit reached/)
  await ok(h.call({}, 'fixture_measure'))
  await denied(h.call({}, 'fixture_measure'), /budget is exhausted/)
})

test('invalid directory settings and pre-existing content are never claimed or overwritten', async t => {
  for (const path of ['..', '.', '../source', '/tmp', '.git', 'node_modules', 'a/b']) {
    assert.equal(configurationSchema.safeParse({ outputDirectory: path }).success, false, path)
  }
  const h = await host(t)
  const root = join(h.directory, '.super-research'); await mkdir(root)
  await writeFile(join(root, 'user.txt'), 'preserve me')
  await denied(h.propose(), /not empty/)
  assert.deepEqual(await readdir(root), ['user.txt'])
  assert.equal(await readFile(join(root, 'user.txt'), 'utf8'), 'preserve me')
  await denied(h.call({}, 'fixture_measure'), /export is incomplete/)
  assert.equal(h.calls(), 0)
})

test('root, study and export-file symbolic links cannot redirect generated artifacts', async t => {
  for (const location of ['root', 'study', 'file']) await t.test(location, async t => {
    const h = await host(t)
    const outside = join(h.directory, 'outside'); await mkdir(outside)
    const root = join(h.directory, '.super-research')
    if (location === 'root') {
      await symlink(outside, root)
      await denied(h.propose(), /symbolic link/)
    } else {
      await ok(h.propose())
      const study = h.state().workspace.directory
      if (location === 'study') {
        await rm(study, { recursive: true }); await symlink(outside, study)
      } else await symlink(join(outside, 'report.md'), join(study, 'report.md'))
      if (location === 'file') {
        await ok(h.confirm())
        const e = h.user('source')
        await ok(h.record({ action: 'evidence', evidence: { id: 'e1', kind: 'supplied', claim: 'source', sourceSeq: e.seq, quote: 'source', ref: '' } }))
        await denied(h.record({ action: 'report', report: { summary: '当前仅有有限证据，尚不能推广结论。', text: 'report', evidenceIds: ['e1'], limits: 'limited' } }), /symbolic link|escapes/)
      } else await denied(h.call({ action: 'read' }), /symbolic link|escapes/)
    }
    assert.deepEqual(await readdir(outside), [])
  })
})

test('read-only policy blocks all exports and retry after write permission does not duplicate the proposal', async t => {
  const h = await host(t, { sandboxMode: 'read-only' })
  await denied(h.propose(), /read-only/)
  assert.deepEqual(await readdir(h.directory), [])
  const seq = h.session.seq
  h.session.append('sandbox/mode', { mode: 'workspace-write' })
  await ok(h.call({ action: 'read' }))
  assert.equal(h.session.seq, seq + 1)
  assert.equal(JSON.parse(await readFile(join(h.state().workspace.directory, 'study.json'), 'utf8')).revision, 1)
})

test('failed exports block dispatch, can retry idempotently and rebuild after a store restart', async t => {
  const h = await host(t)
  const original = h.ctx.fs.writeText.bind(h.ctx.fs)
  let fail = true
  h.ctx.fs.writeText = async (...args) => {
    if (fail && h.ctx.fs.processPath(args[0]).endsWith('/study.json')) throw new Error('export fixture failed')
    return original(...args)
  }
  const command = { action: 'propose', proposal }
  await denied(h.record(command, { requestId: 'retry' }), /export fixture failed/)
  const seq = h.session.seq
  await denied(h.call({}, 'fixture_measure'), /export is incomplete/)
  fail = false
  await ok(h.record(command, { requestId: 'retry', expectedRevision: 0 }))
  assert.equal(h.session.seq, seq)
  const path = join(h.state().workspace.directory, 'study.json')
  await rm(path)
  await new ResearchStore(h.ctx).ensureWorkspace(h.session, signal())
  assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, 1)
  assert.equal(h.calls(), 0)
})

test('file tools reject source writes and managed views; shell requires the artifact workdir', async t => {
  const h = await host(t)
  for (const name of ['write', 'edit', 'bash', 'pwsh']) h.ctx.tools.register(defineTool({
    name, description: 'Dispatch-boundary fixture', parameters: { file_path: { type: 'string' }, workdir: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'dispatched',
  }))
  await ok(h.propose()); await ok(h.confirm())
  const root = h.state().workspace.directory
  await denied(h.call({ file_path: join(h.directory, 'source.js') }, 'write'), /must be written under/)
  await denied(h.call({ file_path: join(root, 'study.json') }, 'edit'), /host-owned/)
  await denied(h.call({}, 'bash'), /workdir=/)
  await denied(h.call({ workdir: h.directory }, 'pwsh'), /workdir must be under/)
  await symlink(h.directory, join(root, 'outputs'))
  await denied(h.call({ file_path: join(root, 'outputs', 'escape.txt') }, 'write'), /must be written under/)
  assert.equal(h.state().operations.length, 0)
  await ok(h.call({ file_path: join(root, 'scripts', 'check.js') }, 'write'))
  await ok(h.call({ workdir: root }, 'bash'))
  assert.equal(h.state().operations.length, 2)
})

test('legacy snapshots replay unchanged and adopt an artifact directory without replaying operations', async t => {
  const h = await host(t, { configuration: { maxToolCalls: 1, maxEvidence: 1, maxNodes: 1, maxExperiments: 1 } })
  let state = emptyState()
  const commands = [
    { action: 'propose', proposal },
    { action: 'confirm', user: { seq: 1, quote: '确认方案' } },
    { action: 'begin', operation: { id: 'old-op', tool: 'bash' } },
    { action: 'settle', id: 'old-op', outcome: 'completed' },
  ]
  for (const [i, command] of commands.entries()) {
    const record = { version: 1, requestId: `legacy${i}`, expectedRevision: state.revision, digest: digestOf(command), command }
    state = transition(state, record, h.session.seq)
    appendPluginRecord(h.session, RECORD_TYPE, { ...record, state })
  }
  assert.deepEqual(h.state(), state)
  assert.equal(Object.hasOwn(h.state(), 'workspace'), false)
  const seq = h.session.seq
  await ok(h.call({ action: 'read' }))
  assert.equal(h.session.seq, seq + 1)
  assert.equal(h.state().status, 'running')
  assert.deepEqual(h.state().operations, state.operations)
  assert.equal(h.state().workspace.settings.maxToolCalls, 6)
  assert.equal(h.state().workspace.settings.maxEvidence, 64)
  await ok(h.record(commands[0], { requestId: 'legacy0', expectedRevision: 0 }))
  assert.equal(h.session.seq, seq + 1)
  assert.equal(h.calls(), 0)
  await ok(h.call({ action: 'read' }))
  assert.equal(h.session.seq, seq + 1)
  const result = await h.ctx.tools.execute({ name: 'fixture_measure', arguments: {}, agent: h.agent, signal: signal(), callId: ToolCallId('after-adopt') })
  await ok(result)
  assert.equal(h.calls(), 1)
})
