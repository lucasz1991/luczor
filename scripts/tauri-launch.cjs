const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

async function freePort(start = 1420, host = '127.0.0.1') {
  for (let port = start; port < start + 100; port++) {
    const available = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', error => {
        if (error.code === 'EADDRINUSE') resolve(false)
        else reject(error)
      })
      server.listen(port, host, () => server.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error('No free Luczor development port found.')
}

async function main() {
  const args = process.argv.slice(2)
  const env = { ...process.env }
  if (args[0] === 'dev') {
    const host = env.TAURI_DEV_HOST || '127.0.0.1'
    const port = await freePort(1420, host)
    env.LUCZOR_DEV_PORT = String(port)
    env.LUCZOR_DEV_BIND_HOST = host
    const urlHost = host.includes(':') ? `[${host}]` : host
    const separator = args.indexOf('--')
    args.splice(
      separator < 0 ? args.length : separator,
      0,
      '--config',
      JSON.stringify({ build: { devUrl: `http://${urlHost}:${port}` } })
    )
    console.log(`Luczor development server: http://${urlHost}:${port}`)
  }
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js')
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }
  child.once('error', error => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 130 : 1)
  })
}

module.exports = { freePort }
if (require.main === module)
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
