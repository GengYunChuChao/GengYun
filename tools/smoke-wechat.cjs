// Optional local-tool check, not part of CI or the full GY-I02 test:mini command.
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

async function main() {
  const args = process.argv.slice(2)
  assert.equal(args.length, 2, 'Usage: node tools/smoke-wechat.cjs <SDK module directory> <local|release>')
  assert.ok(['local', 'release'].includes(args[1]))
  const automator = require(path.resolve(args[0]))
  let mini
  for (let attempt = 0; attempt < 30; attempt++) {
    try { mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' }); break } catch (error) {
      if (attempt === 29) throw error
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  let server
  try {
    let ready = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const page = await mini.currentPage()
        if (page && await page.$('.title')) { ready = true; break }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    assert.ok(ready, 'Simulator did not render a page within 30 seconds')
    const info = await mini.systemInfo()
    console.log(JSON.stringify({ platform: info.platform, SDKVersion: info.SDKVersion }))
    const routes = ['home', 'identify', 'community', 'messages', 'profile']
    const titles = ['耕云', '识别', '社区', '消息', '我的']
    for (let i = 0; i < routes.length; i++) {
      const route = 'pages/' + routes[i] + '/' + routes[i]
      const page = await mini.switchTab('/' + route)
      assert.ok(page); assert.equal(page.path, route)
      await page.waitFor('.title')
      assert.equal(await (await page.$('.title')).text(), titles[i])
      console.log('PASS rendered tab: ' + route)
    }
    const home = await mini.switchTab('/pages/home/home')
    assert.equal(await home.data('local'), args[1] === 'local')
    if (args[1] === 'local') {
      // No wx mocks: exercise the actual simulator request and failure/retry states.
      const root = path.resolve(__dirname, '..')
      server = spawn(process.execPath, ['tools/local-debug-server.mjs', '--config', 'config/debug.local.json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error('Diagnostic server exited before readiness') }), new Promise((_, reject) => setTimeout(() => reject(new Error('Readiness timeout')), 5000))])
      const button = await home.$('button')
      assert.ok(button)
      await button.tap()
      await home.waitFor(async () => {
        const data = await home.data()
        return !data.busy && /连接成功|连接失败|不符合/.test(data.status)
      })
      const success = await home.data('status')
      assert.match(success, /本地替身连接成功/)
      console.log('PASS actual simulator local HTTP success, explicitly synthetic')
      const exited = once(server, 'exit'); server.kill(); await exited; server = null
      await button.tap()
      await home.waitFor(async () => /连接失败/.test(await home.data('status')))
      assert.match(await home.data('status'), /连接失败/)
      console.log('PASS actual simulator stopped-service failure and reusable button')
    } else {
      assert.equal(await home.$('button'), null)
      console.log('PASS release-preparation copy has no local diagnostic button')
    }
    await mini.screenshot({ path: path.resolve(__dirname, '../.local/wechat-' + args[1] + '-smoke.png') })
    console.log('PASS WeChat simulator only; not device, real auth, AI, domain or competition acceptance')
  } finally {
    if (server) server.kill()
    mini.disconnect()
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
