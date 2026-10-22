/**
 * Install the usage kit into a DSH profile's own patch layer.
 *
 * The profile's `cordis.patch.yml` is the user patch layer the running
 * launcher watches (`patchReload: live`), so appending the row here is what
 * makes the plugin load on the next index render. The Desktop client runs the
 * `desktop` profile; a plain `dsh web` run uses `web`, which is why the profile
 * is detected before it is written.
 *
 * Idempotent: an existing `usage-kit` row is reported and left alone.
 *
 * Usage: node scripts/install.mjs [--home <DSH_HOME>] [--profile desktop|web] [--host <file-url>] [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

const flag = name => process.argv.includes(`--${name}`)

function pathToFileURLOf(absolute) {
  const posix = absolute.replaceAll('\\', '/')
  return `file:///${posix.replace(/^\/+/, '')}`
}

const home = option('home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
const profilesDir = join(home, 'profiles')

function defaultProfile() {
  if (existsSync(join(profilesDir, 'desktop'))) return 'desktop'
  if (existsSync(join(profilesDir, 'web'))) return 'web'
  return 'web'
}

const profile = option('profile') ?? defaultProfile()
const patchPath = join(profilesDir, profile, 'cordis.patch.yml')
const hostEntry = option('host') ?? pathToFileURLOf(join(PACKAGE_DIR, 'src', 'index.ts'))

if (!existsSync(join(profilesDir, profile))) {
  console.error(`[install] no profile at ${join(profilesDir, profile)}`)
  console.error('[install] pass --home <DSH_HOME> or start the client once to create the profile')
  process.exit(1)
}

const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '# Your patch layer for this dsh profile.\n[]\n'

if (/^\s*-?\s*id:\s*usage-kit\s*$/m.test(existing) || existing.includes('dsh-usage-kit/src/index.ts')) {
  console.log(`[install] usage-kit is already present in ${patchPath}`)
  process.exit(0)
}

function merged(text) {
  const block = [
    '',
    '# dsh-usage-kit: context coach above the composer + per-turn usage receipts.',
    '- insert:',
    '    - id: usage-kit',
    `      name: '${hostEntry}'`,
    '      config:',
    '        widgets:',
    '          coach: true',
    '          receipt: true',
    '        coach:',
    '          occupancyWarn: 0.8',
    '          projectedWarn: 0.9',
    '          cacheHitFloor: 0.8',
    '          minPromptTokens: 20000',
    '        cnyPerUsd: 7.2',
    '        holidays: []',
    '        turnsKept: 300',
    '',
  ].join('\n')
  const stripped = text.replace(/^\s*\[\s*\]\s*$/m, '')
  return `${stripped.replace(/\s*$/, '')}\n${block}`
}

const next = merged(existing)

if (flag('dry-run')) {
  console.log(`[install] would write ${patchPath}:\n`)
  console.log(next)
  process.exit(0)
}

writeFileSync(patchPath, next)
console.log(`[install] wrote ${patchPath}`)
console.log(`[install] profile: ${profile}`)
console.log(`[install] host half: ${hostEntry}`)
console.log('[install] the profile reloads this file live — reload the page to see the widgets.')
