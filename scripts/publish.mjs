/**
 * Publish the usage kit to its GitHub repository through the REST Contents API.
 *
 * Content-addressed API calls instead of `git push`: no credential helper, no
 * token in any remote URL, nothing left behind in a repository config. The
 * publish is idempotent — unchanged files are skipped, existing paths are
 * updated against their current blob SHA — and creates the repository on the
 * first run when it does not exist.
 *
 * Usage: node scripts/publish.mjs [--repo <owner>/<name>] [--private] [--dry-run]
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')
const WORKSPACE = resolve(PACKAGE_DIR, '..')
const API = 'https://api.github.com'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback
}

const REPO = option('repo', 'marksimZ/dsh-usage-kit')
const DRY_RUN = process.argv.includes('--dry-run')
const PRIVATE = process.argv.includes('--private')

const DESCRIPTION = 'DSH plugin: an actionable context coach above the composer and a per-turn usage receipt (steps, tokens, cache hit, cost, duration) under every completed turn.'

const TOPICS = [
  'deepseek-harness',
  'dsh',
  'dsh-plugin',
  'cordis',
  'cordis-plugin',
  'context-window',
  'usage',
  'cost',
  'web-ui',
  'plugin',
]

const FILES = [
  { from: '.gitignore', to: '.gitignore', message: 'Add repository ignore rules' },
  { from: 'LICENSE', to: 'LICENSE', message: 'Add MIT license' },
  { from: 'package.json', to: 'package.json', message: 'Add plugin manifest with the dsh.client declaration' },
  { from: 'cordis.patch.yml', to: 'cordis.patch.yml', message: 'Add the loader overlay row with per-widget switches' },
  { from: 'src/pricing.js', to: 'src/pricing.js', message: 'Add the pinned price catalog and billing math' },
  { from: 'src/index.ts', to: 'src/index.ts', message: 'Add host half: per-turn receipt folding and its route' },
  { from: 'src/client.js', to: 'src/client.js', message: 'Add browser half: context coach and turn receipt widgets' },
  { from: 'scripts/pricing-spec.mjs', to: 'scripts/pricing-spec.mjs', message: 'Pin the price catalog and the peak calendar' },
  { from: 'scripts/client-spec.mjs', to: 'scripts/client-spec.mjs', message: 'Pin the coach advice rules and the receipt model' },
  { from: 'scripts/client-smoke.mjs', to: 'scripts/client-smoke.mjs', message: 'Add the bundle-load and widget-switch smoke test' },
  { from: 'scripts/host-smoke.mjs', to: 'scripts/host-smoke.mjs', message: 'Add the host smoke test over the real receipts route' },
  { from: 'scripts/theme-tokens.mjs', to: 'scripts/theme-tokens.mjs', message: 'Guard theme-token references against silent fallback' },
  { from: 'scripts/visual-tokens.mjs', to: 'scripts/visual-tokens.mjs', message: 'Guard the visual layer: tokens only, no raw colours' },
  { from: 'scripts/install.mjs', to: 'scripts/install.mjs', message: 'Add the profile installer' },
  { from: 'scripts/verify-deployed.mjs', to: 'scripts/verify-deployed.mjs', message: 'Add the deployed-GUI verification probe' },
  { from: 'scripts/publish.mjs', to: 'scripts/publish.mjs', message: 'Add the publisher' },
  { from: 'README.md', to: 'README.md', message: 'Document the two widgets: install, configuration, architecture, tests' },
]

const TOKEN_CANDIDATES = [
  process.env.GITHUB_TOKEN_FILE,
  join(PACKAGE_DIR, 'githubtoken.txt'),
  join(WORKSPACE, 'githubtoken.txt'),
  join(process.env.USERPROFILE ?? homedir(), 'githubtoken.txt'),
].filter(candidate => typeof candidate === 'string' && candidate.length > 0)

function token() {
  const fromEnv = process.env.GITHUB_TOKEN
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
  for (const candidate of TOKEN_CANDIDATES) {
    try {
      const value = readFileSync(candidate, 'utf8').trim()
      if (value.length > 0) return value
    } catch {
      // Not there; try the next location.
    }
  }
  throw new Error(`no GitHub token: set GITHUB_TOKEN, or place one at ${TOKEN_CANDIDATES.join(' | ')}`)
}

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-usage-kit-publisher',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })
  const text = await response.text()
  let payload
  try { payload = text.length === 0 ? undefined : JSON.parse(text) } catch { payload = text }
  return { status: response.status, ok: response.ok, payload }
}

function clean(payload) {
  const value = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return value.replaceAll(/gh[pousr]_[A-Za-z0-9]+/g, '<redacted>').slice(0, 700)
}

const [owner, repoName] = REPO.split('/')
if (owner === undefined || repoName === undefined) throw new Error(`--repo must be <owner>/<name>, got ${REPO}`)

console.log(`[publish] repository: ${REPO}${DRY_RUN ? ' (dry run)' : ''}`)

if (!DRY_RUN) {
  let meta = await api(`/repos/${REPO}`)
  if (meta.status === 404) {
    const me = await api('/user')
    if (!me.ok) throw new Error(`cannot identify the token owner: HTTP ${me.status} ${clean(me.payload)}`)
    const path = me.payload.login === owner ? '/user/repos' : `/orgs/${owner}/repos`
    const created = await api(path, {
      method: 'POST',
      body: JSON.stringify({ name: repoName, description: DESCRIPTION, private: PRIVATE, has_issues: true, has_wiki: false, has_projects: false, auto_init: false }),
    })
    if (!created.ok) throw new Error(`cannot create ${REPO}: HTTP ${created.status} ${clean(created.payload)}`)
    console.log(`[publish] created ${created.payload.full_name} (private=${created.payload.private})`)
    meta = { ok: true, payload: created.payload }
  } else if (!meta.ok) {
    throw new Error(`cannot read ${REPO}: HTTP ${meta.status} ${clean(meta.payload)}`)
  } else {
    console.log(`[publish] found repository (private=${meta.payload.private})`)
  }
  const branch = meta.payload.default_branch ?? 'main'

  if (meta.payload.description !== DESCRIPTION) {
    const patched = await api(`/repos/${REPO}`, { method: 'PATCH', body: JSON.stringify({ description: DESCRIPTION }) })
    if (!patched.ok) throw new Error(`description update failed: HTTP ${patched.status} ${clean(patched.payload)}`)
    console.log('[publish] description set')
  }
  const topics = await api(`/repos/${REPO}/topics`, { method: 'PUT', body: JSON.stringify({ names: TOPICS }) })
  if (!topics.ok) throw new Error(`topics update failed: HTTP ${topics.status} ${clean(topics.payload)}`)
  console.log(`[publish] topics: ${(topics.payload.names ?? []).join(', ')}`)

  let uploaded = 0
  let skipped = 0
  for (const file of FILES) {
    const local = join(PACKAGE_DIR, file.from)
    statSync(local)
    const bytes = readFileSync(local)
    const current = await api(`/repos/${REPO}/contents/${file.to}?ref=${branch}`)
    if (!current.ok && current.status !== 404) {
      throw new Error(`cannot read ${file.to}: HTTP ${current.status} ${clean(current.payload)}`)
    }
    if (current.ok && String(current.payload.content ?? '').replaceAll('\n', '') === bytes.toString('base64')) {
      skipped += 1
      console.log(`[publish] = ${file.to} (already current)`)
      continue
    }
    console.log(`[publish] ${current.ok ? 'update' : 'create'} ${file.to} (${bytes.length} bytes)`)
    const put = await api(`/repos/${REPO}/contents/${file.to}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: file.message,
        content: bytes.toString('base64'),
        ...(current.ok ? { sha: current.payload.sha } : {}),
        branch,
      }),
    })
    if (!put.ok) throw new Error(`upload of ${file.to} failed: HTTP ${put.status} ${clean(put.payload)}`)
    uploaded += 1
  }
  console.log(`\n[publish] ${uploaded} uploaded, ${skipped} already current`)
} else {
  for (const file of FILES) {
    statSync(join(PACKAGE_DIR, file.from))
    console.log(`[publish] would upload ${file.to}`)
  }
}

console.log(`[publish] https://github.com/${REPO}`)
