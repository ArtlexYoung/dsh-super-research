import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { boot, composeEntries } from '@deepseek-ai/dsh-app-boot'
import yaml from 'js-yaml'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { agentIn, plain, proposal } from './helpers.js'
import { DESCRIPTION } from '../src/config.js'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const entrySchema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => ({ __jsExpr: value }),
}))
const hostNames = ['system-prompt', 'tools', 'session', 'session-projection', 'session-persistence-jsonl',
  'fs-local', 'working-directory', 'sandbox-policy', 'config-editor', 'settings', 'shell', 'shell-env', 'subprocess', 'web', 'skill', 'agent', 'agent-preset-registry']

test('real Loader composes the shipped preset, host writes reopen with the official persistence reader', async t => {
  await mkdir(join(root, '.development'), { recursive: true })
  const dir = await mkdtemp(join(root, '.development/composition-'))
  const rows = hostNames.map(name => ({ id: name, name: require.resolve(`@deepseek-ai/dsh-${name}`), config:
    name === 'session-persistence-jsonl' ? { root: join(dir, 'sessions'), compression: 'none' }
      : name === 'sandbox-policy' ? { mode: 'workspace-write', workspaceRoot: dir }
        : name === 'agent-preset-registry' ? { default: 'ordinary' } : {} }))
  rows.push({ id: 'preset-ordinary', name: require.resolve('@deepseek-ai/dsh-agent-preset'),
    config: { id: 'ordinary', name: 'Ordinary', plugins: [] } })
  rows.push({ id: 'preset-broken-research', name: require.resolve('@deepseek-ai/dsh-agent-preset'),
    config: { id: 'broken-research', name: 'Failure fixture', plugins: [{ id: 'failed-research', name: join(root, 'test/fixtures/failing.js') }] } })
  const patches = yaml.load(await readFile(join(root, 'cordis.patch.yml'), 'utf8'), { schema: entrySchema })
  const profileDir = join(dir, 'profile')
  await mkdir(profileDir)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'research-test-profile', private: true, dsh: { profile: { bundles: [] } } }))
  const patchPath = join(profileDir, 'cordis.patch.yml')
  await writeFile(patchPath, JSON.stringify([{ insert: rows }, ...patches]))
  const config = join(dir, 'cordis.json')
  await writeFile(config, '[]')
  let ctx
  t.after(async () => { if (ctx) await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  ctx = await boot('super-research-composition', config, [{ insert: rows }, ...patches], owner => {
    owner.provide('profileContext', { name: 'test', dir: profileDir, home: dir, patchPath, installAnchor: join(root, 'package.json'), overlays: [] })
  })
  const roster = await ctx.agentPresets.list()
  assert.equal(roster.find(row => row.id === 'super-research')?.broken, undefined, JSON.stringify(roster))
  assert.equal(roster.find(row => row.id === 'super-research')?.name, 'Super Research 模式')
  assert.equal(roster.find(row => row.id === 'super-research')?.description, DESCRIPTION)
  const setting = ctx.settings.describe().find(row => row.ns === 'super-research-workbench')
  assert.equal(setting.autoGenerate, false)
  assert.equal(setting.value.maxToolCalls, 40)
  assert.match(roster.find(row => row.id === 'broken-research')?.broken || '', /failed|error/i)
  const session = ctx.sessions.create(SessionId('real-study'), { meta: { cwd: dir, agentPreset: 'super-research' } })
  const owner = agentIn(ctx, session)
  t.after(() => owner.scope.dispose())
  await ctx.agentPresets.mount(owner.scope.ctx, 'super-research')
  const writer = await ctx.sessionPersistence.create(session.header)
  t.after(() => writer.close())
  const call = args => ctx.tools.execute({ name: 'super_research', arguments: args, agent: owner.agent,
    signal: new AbortController().signal, callId: ToolCallId(`real-${Math.random()}`) })
  const result = await call({ action: 'record', requestId: 'real-proposal', expectedRevision: 0, record: JSON.stringify({ action: 'propose', proposal }) })
  assert.equal(result.isError, false, plain(result))
  const confirmation = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '确认方案' }] }), { surfaceOp: 'append' })
  const confirmed = await call({ action: 'record', requestId: 'real-confirmation', expectedRevision: 1,
    record: JSON.stringify({ action: 'confirm', user: { seq: confirmation.seq, quote: '确认方案' } }) })
  assert.equal(confirmed.isError, false, plain(confirmed))
  assert.equal(JSON.parse(await readFile(join(ctx.sessionProjections.stateOf(session, 'superResearch').workspace.directory, 'study.json'), 'utf8')).status, 'running')
  const frozen = ctx.sessionProjections.stateOf(session, 'superResearch').workspace
  await ctx.settings.mutate(setting.ns, [{ op: 'set', path: ['maxToolCalls'], value: 12 }, { op: 'set', path: ['outputDirectory'], value: '.studies' }], setting.revision)
  assert.equal(ctx.superResearchConfiguration.read().maxToolCalls, 12)
  assert.equal(ctx.settings.describe().find(row => row.ns === setting.ns).value.outputDirectory, '.studies')
  assert.match(await readFile(patchPath, 'utf8'), /maxToolCalls: 12/)
  assert.deepEqual(ctx.sessionProjections.stateOf(session, 'superResearch').workspace, frozen)
  await assert.rejects(ctx.settings.mutate(setting.ns, [{ op: 'set', path: ['maxToolCalls'], value: 2 }], setting.revision), /revision|conflict/i)
  await assert.rejects(ctx.settings.mutate(setting.ns, [{ op: 'set', path: ['outputDirectory'], value: '../src' }]), /pattern|match/i)
  assert.equal(ctx.superResearchConfiguration.read().outputDirectory, '.studies')
  await ctx.settings.mutate(setting.ns, [
    { op: 'set', path: ['maxToolCalls'], value: 0 },
    { op: 'set', path: ['maxEvidence'], value: 1000000000 },
    { op: 'set', path: ['maxNodes'], value: 0 },
    { op: 'set', path: ['maxExperiments'], value: 999999999 },
  ])
  assert.equal(ctx.superResearchConfiguration.read().maxToolCalls, 0)
  assert.equal(ctx.superResearchConfiguration.read().maxEvidence, 1000000000)
  assert.equal(ctx.superResearchConfiguration.read().maxNodes, 0)
  assert.equal(ctx.superResearchConfiguration.read().maxExperiments, 999999999)
  assert.match(await readFile(patchPath, 'utf8'), /maxToolCalls: 0/)

  const assembly = await ctx.systemPrompt.assemble({ agent: owner.agent, scope: owner.agent })
  assert.ok(assembly.tools.some(tool => tool.name === 'super_research'))
  assert.ok(assembly.sections.some(section => section.text.includes('You are Super Research')))
  await writer.close()
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  const saved = await reader.read()
  assert.ok(saved.events.some(event => event.type === 'plugin:dsh-super-research/event' && event.data.state.status === 'running'))
  const reopened = Session.fromRestore(session.id, saved.events, reader.header, reader.inheritedEventCount, saved.eventState)
  assert.equal(ctx.sessionProjections.stateOf(reopened, 'superResearch').status, 'interrupted')
  await reader.close()
  const ordinary = ctx.sessions.create(SessionId('ordinary-session'))
  const ordinaryOwner = agentIn(ctx, ordinary)
  t.after(() => ordinaryOwner.scope.dispose())
  await ctx.agentPresets.mount(ordinaryOwner.scope.ctx, 'ordinary')
  const basic = await ctx.systemPrompt.assemble({ agent: ordinaryOwner.agent, scope: ordinaryOwner.agent })
  assert.equal(basic.tools.some(tool => tool.name === 'super_research'), false)
  assert.equal(basic.sections.some(section => section.text.includes('You are Super Research')), false)
})

test('the distributable preset and bundle declaration contain the same host capability set', async () => {
  const bundle = yaml.load(await readFile(join(root, 'cordis.patch.yml'), 'utf8'), { schema: entrySchema })
  const declaration = bundle.flatMap(row => row.insert).find(row => row.id === 'preset-super-research')
  const composition = yaml.load(await readFile(join(root, 'presets/super-research/agent.cordis.yml'), 'utf8'), { schema: entrySchema })
  assert.deepEqual(declaration.config.plugins, composition)
  const info = yaml.load(await readFile(join(root, 'presets/super-research/preset.yml'), 'utf8'))
  assert.equal(declaration.config.name, info.name)
  assert.equal(declaration.config.description, info.description)
  assert.equal(composition.some(row => /subagent|agent-team/.test(row.name)), false)
})
