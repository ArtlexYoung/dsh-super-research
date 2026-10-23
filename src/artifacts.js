import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { demand } from './state.js'
import { DEFAULTS, workspaceSchema } from './config.js'

const json = value => JSON.stringify(value, null, 2) + '\n'
const owner = { plugin: 'dsh-super-research', version: 1 }

/** Project views of host-owned records; all IO uses the current host policy. */
export class ResearchArtifacts {
  constructor(ctx) { this.ctx = ctx }
  async workspace(session, legacyBudget = 0) {
    const settings = this.ctx.superResearchConfiguration.read()
    const project = session.header.cwd || this.ctx.workingDirectory.get(session)
    const key = 'study-' + createHash('sha256').update(session.id).digest('hex').slice(0, 20)
    const relativeDirectory = join(settings.outputDirectory, key)
    return workspaceSchema.parse({ project, directory: join(project, relativeDirectory), relativeDirectory,
      settings: legacyBudget ? { ...DEFAULTS, outputDirectory: settings.outputDirectory, maxToolCalls: legacyBudget } : settings })
  }
  async target(workspace, path, signal) {
    const fs = this.ctx.fs
    const project = await fs.resolve(workspace.project, { signal })
    const root = await fs.resolve(workspace.directory, { signal })
    const target = await fs.resolve(path, { cwd: workspace.directory, signal })
    demand(fs.contains(project, root) && fs.contains(root, target), 'Research artifact path escapes its project directory')
    // resolve follows aliases; lstat also rejects links that remain inside the project.
    const parts = [workspace.settings.outputDirectory, workspace.relativeDirectory.split(/[\\/]/).at(-1), ...path.split(/[\\/]/)]
    let current = workspace.project
    for (const part of parts) {
      demand(part && part !== '.' && part !== '..', 'Invalid research artifact path')
      current = join(current, part)
      const info = await fs.lstat(current, {}, signal)
      demand(!info || info.type !== 'symlink', 'Research artifact paths must not contain symbolic links')
    }
    return target
  }
  async write(workspace, path, content, signal, policy) {
    const target = await this.target(workspace, path, signal)
    const info = await this.ctx.fs.stat(target, signal)
    demand(!info || info.type === 'file', 'Research export target is not a regular file')
    await this.ctx.fs.writeText(target, content, info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' }, signal, policy)
  }
  async marker(path, expected, signal, policy) {
    const fs = this.ctx.fs
    demand((await fs.lstat(path, {}, signal))?.type !== 'symlink', 'Research directory ownership marker must not be a symbolic link')
    const target = await fs.resolve(path, { signal })
    const info = await fs.stat(target, signal)
    if (!info) {
      try { await fs.writeText(target, json(expected), { kind: 'createIfAbsent' }, signal, policy) }
      catch (error) { if (!await fs.stat(target, signal)) throw error }
    }
    demand(await fs.readText(target, signal) === json(expected), 'Research directory belongs to other content; choose another output directory')
  }
  async initialize(session, workspace, signal, policy) {
    const fs = this.ctx.fs
    const project = await fs.resolve(workspace.project, { signal })
    const rootPath = join(workspace.project, workspace.settings.outputDirectory)
    demand((await fs.lstat(rootPath, {}, signal))?.type !== 'symlink', 'Research output directory must not be a symbolic link')
    const root = await fs.resolve(rootPath, { signal })
    demand(fs.contains(project, root), 'Research output directory escapes the project')
    if (policy.mode === 'workspace-write') {
      const permitted = await fs.resolve(policy.workspaceRoot, { signal })
      demand(fs.contains(permitted, root), 'Research output directory is outside the permitted workspace')
    }
    const rootMarker = join(rootPath, '.super-research.json')
    if (await fs.stat(root, signal) && !await fs.stat(await fs.resolve(rootMarker, { signal }), signal)) {
      demand((await fs.listDir(root, signal)).length === 0, 'Research output directory is not empty; choose a dedicated directory')
    }
    await this.marker(rootMarker, owner, signal, policy)
    // This ignore file itself is ignored. No tracked or repository-level config changes.
    const ignorePath = join(rootPath, '.gitignore')
    demand((await fs.lstat(ignorePath, {}, signal))?.type !== 'symlink', 'Research ignore file must not be a symbolic link')
    const ignore = await fs.resolve(ignorePath, { signal })
    if (!await fs.stat(ignore, signal)) {
      try { await fs.writeText(ignore, '*\n', { kind: 'createIfAbsent' }, signal, policy) }
      catch (error) { if (!await fs.stat(ignore, signal)) throw error }
    }
    demand(await fs.readText(ignore, signal) === '*\n', 'Research ignore file was modified; restore it or choose another output directory')
    const marker = await this.target(workspace, '.super-research.json', signal)
    const study = await fs.resolve(workspace.directory, { signal })
    if (await fs.stat(study, signal) && !await fs.stat(marker, signal)) {
      demand((await fs.listDir(study, signal)).length === 0, 'Research study directory contains unowned files')
    }
    await this.marker(fs.processPath(marker), { ...owner, sessionId: session.id }, signal, policy)
  }
  async sync(session, state, signal) {
    if (!state.workspace) return { exported: false }
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    demand(policy.mode !== 'read-only', 'Research artifact export is blocked by read-only mode; enable workspace writes and retry super_research read')
    const workspace = workspaceSchema.parse(state.workspace)
    await this.initialize(session, workspace, signal, policy)
    const files = {
      'proposal.md': `# ${state.proposal.title}\n\n${state.proposal.question}\n\n## 方法\n\n${state.proposal.approach}\n\n## 验收标准\n\n${state.proposal.criteria.map(item => '- ' + item).join('\n')}\n\n${state.proposal.protocol}\n`,
      'evidence.json': json(state.evidence), 'exploration.json': json(state.nodes),
      'experiments.json': json(state.experiments), 'operations.json': json(state.operations),
      'README.md': '# 研究产物\n\n本目录属于一个 DSH 研究会话。proposal.md、evidence.json、exploration.json、experiments.json、operations.json、report.md 和 study.json 是自动生成的视图，请通过对话修订。DSH 会话记录是恢复来源。\n\n实验脚本放在 scripts/，数据副本与输出放在 outputs/，临时文件放在 tmp/；不要修改项目源码。整个研究目录默认由自身的 .gitignore 排除。\n',
      ...(state.report ? { 'report.md': `# 研究报告\n\n${state.report.summary ? `## 总结\n\n${state.report.summary}\n\n` : ''}${state.report.text}\n\n## 限制与不确定性\n\n${state.report.limits}\n\n引用证据：${state.report.evidenceIds.join('、')}\n` } : {}),
    }
    for (const [path, content] of Object.entries(files)) await this.write(workspace, path, content, signal, policy)
    // Publish the complete snapshot last; a failed export is retried before more work.
    await this.write(workspace, 'study.json', json(state), signal, policy)
    return { exported: true, directory: workspace.directory, revision: state.revision }
  }
  async checkExecution(state, exec) {
    const workspace = state.workspace
    demand(workspace, 'Read super_research before dispatch to prepare the research artifact directory')
    if (['write', 'edit'].includes(exec.name)) {
      const target = await this.ctx.fs.resolve(exec.arguments.file_path, { cwd: this.ctx.workingDirectory.get(exec.agent.session), signal: exec.signal })
      const root = await this.ctx.fs.resolve(workspace.directory, { signal: exec.signal })
      demand(this.ctx.fs.contains(root, target), `Research files must be written under ${workspace.directory}; project sources are read-only`)
      const path = relative(this.ctx.fs.processPath(root), this.ctx.fs.processPath(target))
      demand(['scripts', 'outputs', 'tmp'].includes(path.split(/[\\/]/)[0]), 'Write research files under scripts/, outputs/ or tmp/; generated research views are host-owned')
    }
    if (['bash', 'pwsh'].includes(exec.name)) {
      demand(typeof exec.arguments.workdir === 'string', `Run research commands with workdir=${workspace.directory}; read project sources by absolute path`)
      const target = await this.ctx.fs.resolve(exec.arguments.workdir, { cwd: this.ctx.workingDirectory.get(exec.agent.session), signal: exec.signal })
      const root = await this.ctx.fs.resolve(workspace.directory, { signal: exec.signal })
      demand(this.ctx.fs.contains(root, target), `Research command workdir must be under ${workspace.directory}`)
    }
  }
}
