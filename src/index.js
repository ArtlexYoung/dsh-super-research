import { researchProjection } from './projection.js'
import { Config, configurationValues } from './config.js'

export const name = 'super-research-workbench'
export const inject = ['sessionProjections']
export { Config }
/** Host-side view survives cold session reads; execution is preset-scoped. */
export function apply(ctx, config = {}) {
  ctx.provide('superResearchConfiguration', { read: () => configurationValues(config) })
  ctx.inject(['settings'], owner => {
    owner.effect(() => owner.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.sessionProjections.register(researchProjection)
}
