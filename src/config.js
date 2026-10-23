import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'

export const DESCRIPTION = '结合资料检索与实验验证，开展通用研究、算法分析和离线量化，给出有据可查的结论。'
export const directoryPattern = /^(?!\.{1,2}$|\.git$|node_modules$)[.a-zA-Z0-9_-]{1,64}$/
// JSON-safe sentinel: zero means unlimited; Infinity cannot round-trip in JSON.
export const countLimit = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const limitsSchema = z.object({
  maxToolCalls: countLimit, maxEvidence: countLimit, maxNodes: countLimit, maxExperiments: countLimit,
}).strict()
export const withinLimit = (used, limit) => limit === 0 || used < limit
export const limitFits = (value, ceiling) => ceiling === 0 || value !== 0 && value <= ceiling
export const configurationSchema = z.object({
  outputDirectory: z.string().regex(directoryPattern).default('.super-research'),
  maxToolCalls: countLimit.default(40),
  maxEvidence: countLimit.default(64),
  maxNodes: countLimit.default(48),
  maxExperiments: countLimit.default(24),
}).strict()
export const DEFAULTS = configurationSchema.parse({})
export const Config = schema.object({
  outputDirectory: schema.string().pattern(directoryPattern).default(DEFAULTS.outputDirectory).description('项目内产物目录').volatile(),
  maxToolCalls: schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxToolCalls).description('工具调用上限；建议 40，0 为无限制').volatile(),
  maxEvidence: schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxEvidence).description('证据数量上限；建议 64，0 为无限制').volatile(),
  maxNodes: schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxNodes).description('探索节点上限；建议 48，0 为无限制').volatile(),
  maxExperiments: schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxExperiments).description('实验数量上限；建议 24，0 为无限制').volatile(),
})

export function configurationValues(config) {
  return configurationSchema.parse(Object.fromEntries(Object.entries(config).map(([key, value]) =>
    [key, typeof value?.get === 'function' ? value.get() : value])))
}

export const workspaceSchema = z.object({
  project: z.string().min(1), directory: z.string().min(1), relativeDirectory: z.string().min(1),
  settings: configurationSchema,
}).strict()
