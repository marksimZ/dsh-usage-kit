/**
 * Client smoke — prove the bundle loads through the real transport contract
 * and registers the enabled widgets into the right seats.
 *
 * Usage: node scripts/client-smoke.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(resolve(HERE, '..'), 'src', 'client.js')

/** Load one instance with the given injected widget switches. */
async function load(config) {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load: registration => registrations.push(registration) } }
  globalThis.__DSH_USAGE_KIT_CONFIG__ = config
  const tags = []
  globalThis.document = {
    hidden: false,
    head: { appendChild: tag => { tags.push(tag); return tag } },
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    querySelector: () => null,
  }
  await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}${Math.random()}`)
  if (registrations.length !== 1) throw new Error(`expected one registration, got ${registrations.length}`)
  const module = registrations[0].factory(name => {
    if (name !== 'react') throw new Error(`unexpected shared module: ${name}`)
    return {
      createElement: () => ({}),
      Fragment: 'fragment',
      useState: () => [null, () => {}],
      useEffect: () => {},
    }
  })
  return { module, tags }
}

/** Mount the module on a fake slot context and return the registrations. */
function mount(module) {
  const injected = []
  const registered = []
  const effects = []
  const ctx = {
    effect(body) { effects.push(body()); return () => {} },
    slots: {
      inject(name, factory) { injected.push(name); factory(); return () => {} },
      register(registration, component) { registered.push({ registration, component }); return () => {} },
    },
    logger: { warn: () => {}, error: () => {} },
  }
  module.apply(ctx)
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  return { injected, registered }
}

// --- both widgets on ----------------------------------------------------
const both = await load({ widgets: { coach: true, receipt: true } })
if (both.module.name !== 'dsh-usage-kit') throw new Error(`unexpected name: ${both.module.name}`)
if (!Array.isArray(both.module.inject) || !both.module.inject.includes('slots')) throw new Error('module does not inject slots')
const mounted = mount(both.module)
if (mounted.injected.length !== 2) throw new Error(`expected two seats, got ${mounted.injected.join(',')}`)
if (!mounted.injected.includes('conversation.input.dock')) throw new Error('missing composer dock injection')
if (!mounted.injected.includes('conversation.chat.turnTail')) throw new Error('missing turn tail injection')
if (mounted.registered.length !== 2) throw new Error(`expected two registrations, got ${mounted.registered.length}`)
const coach = mounted.registered.find(entry => entry.registration.id === 'usage-coach')
const receipt = mounted.registered.find(entry => entry.registration.id === 'usage-receipt')
if (coach === undefined) throw new Error('missing usage-coach registration')
if (receipt === undefined) throw new Error('missing usage-receipt registration')
if (coach.registration.name !== 'conversation.input.dock') throw new Error('coach registered in the wrong seat')
if (receipt.registration.name !== 'conversation.chat.turnTail') throw new Error('receipt registered in the wrong seat')
if (both.tags.length !== 1) throw new Error(`expected one stylesheet, got ${both.tags.length}`)
const css = String(both.tags[0].textContent)
if (!css.includes('.duk-coach')) throw new Error('stylesheet is missing the coach rule')
if (!css.includes('.duk-receipt')) throw new Error('stylesheet is missing the receipt rule')

console.log('[client-smoke] both widgets registered:', mounted.registered.map(entry => entry.registration.id).join(', '))

// --- coach off ----------------------------------------------------------
const coachOff = await load({ widgets: { coach: false, receipt: true } })
const coachOffMounted = mount(coachOff.module)
if (coachOffMounted.registered.length !== 1) throw new Error('coach switch did not remove its registration')
if (coachOffMounted.registered[0].registration.id !== 'usage-receipt') throw new Error('wrong widget survived the coach switch')
console.log('[client-smoke] coach switch: receipt only')

// --- receipt off --------------------------------------------------------
const receiptOff = await load({ widgets: { coach: true, receipt: false } })
const receiptOffMounted = mount(receiptOff.module)
if (receiptOffMounted.registered.length !== 1) throw new Error('receipt switch did not remove its registration')
if (receiptOffMounted.registered[0].registration.id !== 'usage-coach') throw new Error('wrong widget survived the receipt switch')
console.log('[client-smoke] receipt switch: coach only')

console.log('[client-smoke] stylesheet bytes:', css.length)
console.log('[client-smoke] OK')
