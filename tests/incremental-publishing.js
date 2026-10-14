/* eslint-disable no-underscore-dangle */
// Run with npm run test:publish. A local Git executable is needed only for tests.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const fse = require('fs-extra')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const git = require('isomorphic-git')
const ts = require('typescript')

// Load the actual server code without starting Electron or building the UI.
require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018, esModuleInterop: true },
    fileName: filename,
  })
  module._compile(compiled.outputText, filename)
}
const Deploy = require('../src/server/deploy').default
const clearGeneratedOutput = require('../src/server/utils/clear-generated-output').default

function nativeGit(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function fixture(runFixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridea-publish-'))
  const remote = path.join(root, 'remote.git')
  const output = path.join(root, 'output')
  fse.ensureDirSync(output)
  nativeGit(root, ['init', '--bare', remote])
  nativeGit(remote, ['config', 'http.receivepack', 'true'])
  const uploads = []
  const backend = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend')
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const child = spawn(backend, [], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: request.headers['content-length'] || '',
        REMOTE_USER: 'test',
      },
    })
    let size = 0
    request.on('data', (chunk) => { size += chunk.length })
    request.on('end', () => {
      if (request.method === 'POST' && url.pathname.endsWith('/git-receive-pack')) uploads.push(size)
    })
    request.pipe(child.stdin)
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('close', () => {
      const data = Buffer.concat(chunks)
      let end = data.indexOf('\r\n\r\n')
      let separator = 4
      if (end === -1) { end = data.indexOf('\n\n'); separator = 2 }
      if (end === -1) { response.writeHead(500); response.end(); return }
      const headers = data.slice(0, end).toString().split(/\r?\n/)
      for (const header of headers) {
        const colon = header.indexOf(':')
        const name = header.slice(0, colon)
        const value = header.slice(colon + 1).trim()
        if (name.toLowerCase() === 'status') response.statusCode = parseInt(value, 10)
        else response.setHeader(name, value)
      }
      response.end(data.slice(end + separator))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const setting = {
    platform: 'github',
    username: 'test',
    token: 'test',
    repository: 'remote',
    branch: 'master',
    email: 'test@example.com',
    enabledProxy: 'direct',
    domain: 'https://example.com',
  }
  fse.ensureDirSync(path.join(root, 'config'))
  for (const name of ['setting', 'posts', 'theme']) fse.writeJsonSync(path.join(root, 'config', `${name}.json`), {})
  const deploy = new Deploy({ appDir: root, buildDir: output, db: { setting, themeConfig: {} } })
  deploy.remoteUrl = `http://127.0.0.1:${server.address().port}/remote.git`
  try {
    await runFixture({
      root, remote, output, deploy, uploads, setting,
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
    fse.removeSync(root)
  }
}

async function publish(deploy) {
  const result = await deploy.publish()
  assert.strictEqual(result.success, true, String(result.message))
}

async function run() {
  await fixture(async ({
    output, remote, deploy, uploads,
  }) => {
    // First publish to an empty remote, followed by a real incremental update.
    fs.writeFileSync(path.join(output, 'asset.bin'), crypto.randomBytes(1024 * 1024))
    fs.writeFileSync(path.join(output, 'index.html'), 'first page')
    fse.outputFileSync(path.join(output, 'old-post/index.html'), 'old article')
    await publish(deploy)
    const first = nativeGit(remote, ['rev-parse', 'master'])
    const largeUpload = uploads[0]
    assert(largeUpload > 1024 * 1024)
    const asset = fs.readFileSync(path.join(output, 'asset.bin'))

    clearGeneratedOutput(output)
    assert(fs.existsSync(path.join(output, '.git/HEAD')))
    assert(!fs.existsSync(path.join(output, 'old-post')))
    fs.writeFileSync(path.join(output, 'asset.bin'), asset)
    fs.writeFileSync(path.join(output, 'index.html'), 'updated page')
    await publish(deploy)
    const second = nativeGit(remote, ['rev-parse', 'master'])
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'master^']), first)
    assert.strictEqual(nativeGit(remote, ['show', 'master:index.html']), 'updated page')
    assert(!nativeGit(remote, ['ls-tree', '-r', '--name-only', 'master']).includes('old-post/'))
    assert(uploads[1] < largeUpload / 10, 'unchanged asset should not be uploaded again')

    await publish(deploy)
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'master']), second, 'unchanged output should not create an empty commit')
    console.log('PASS: empty remote, preserved history, deleted pages, incremental upload, unchanged output')

    // Simulate the orphaned cache left by 0.9.3, then a missing cache entirely.
    fse.removeSync(path.join(output, '.git'))
    await git.init({ fs, dir: output })
    await git.add({ fs, dir: output, filepath: '.' })
    await git.commit({
      fs, dir: output, author: { name: 'test', email: 'test@example.com' }, message: 'old orphan cache',
    })
    fs.writeFileSync(path.join(output, 'index.html'), 'migrated cache')
    await publish(deploy)
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'master^']), second)
    assert.strictEqual(nativeGit(remote, ['show', 'master:index.html']), 'migrated cache')
    const migrated = nativeGit(remote, ['rev-parse', 'master'])
    fse.removeSync(path.join(output, '.git'))
    fs.writeFileSync(path.join(output, 'index.html'), 'fresh cache')
    await publish(deploy)
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'master^']), migrated)
    console.log('PASS: orphaned and missing caches reconnect without overwriting rendered pages')

    const beforeFailure = nativeGit(remote, ['rev-parse', 'master'])
    const originalRequest = deploy.http.request.bind(deploy.http)
    deploy.http.request = async () => { throw new Error('connection unavailable') }
    const failed = await deploy.publish()
    assert.strictEqual(failed.success, false)
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'master']), beforeFailure)
    deploy.http.request = originalRequest
    console.log('PASS: failed connection is reported without changing remote history')
  })

  await fixture(async ({
    output, remote, deploy, setting,
  }) => {
    fs.writeFileSync(path.join(output, 'index.html'), 'master page')
    await publish(deploy)
    const master = nativeGit(remote, ['rev-parse', 'master'])
    setting.branch = 'pages/site'
    fs.writeFileSync(path.join(output, 'index.html'), 'new branch page')
    await publish(deploy)
    assert.strictEqual(nativeGit(remote, ['show', 'pages/site:index.html']), 'new branch page')
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'master']), master)
    const target = nativeGit(remote, ['rev-parse', 'pages/site'])
    setting.branch = 'master'
    fs.writeFileSync(path.join(output, 'index.html'), 'master updated')
    await publish(deploy)
    assert.strictEqual(nativeGit(remote, ['show', 'master:index.html']), 'master updated')
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'pages/site']), target)
    setting.branch = 'pages/site'
    fs.writeFileSync(path.join(output, 'index.html'), 'existing nested branch updated')
    await publish(deploy)
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'pages/site^']), target)
    console.log('PASS: new, existing, and nested branch switches preserve freshly rendered content')

    const originalRequest = deploy.http.request.bind(deploy.http)
    let advanced = false
    let concurrent
    deploy.http.request = async (request) => {
      if (!advanced && request.method === 'POST' && request.url.endsWith('/git-receive-pack')) {
        advanced = true
        const parent = nativeGit(remote, ['rev-parse', 'pages/site'])
        const tree = nativeGit(remote, ['rev-parse', 'pages/site^{tree}'])
        concurrent = execFileSync('git', ['-C', remote, '-c', 'user.name=test', '-c', 'user.email=test@example.com',
          'commit-tree', tree, '-p', parent, '-m', 'concurrent publication'], { encoding: 'utf8' }).trim()
        nativeGit(remote, ['update-ref', 'refs/heads/pages/site', concurrent])
      }
      return originalRequest(request)
    }
    fs.writeFileSync(path.join(output, 'index.html'), 'racing publication')
    const rejected = await deploy.publish()
    assert.strictEqual(rejected.success, false, 'concurrent publication must not be force overwritten')
    assert.strictEqual(nativeGit(remote, ['rev-parse', 'pages/site']), concurrent)
    console.log('PASS: concurrent remote changes are rejected instead of force overwritten')
  })
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
