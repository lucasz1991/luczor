const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { freePort } = require('./tauri-launch.cjs')

test('uses another port without interrupting an existing server', async () => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const occupied = server.address().port
    assert.ok((await freePort(occupied)) > occupied)
    assert.equal(server.listening, true)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
