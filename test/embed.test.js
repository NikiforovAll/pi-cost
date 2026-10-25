const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildFixture } = require('./helpers/fixtures');

const fx = buildFixture();
const SERVER = path.join(__dirname, '..', 'server.js');
const LISTENING = /pi-cost listening on http:\/\/localhost:(\d+)/;

let child;
after(() => {
  if (child && child.exitCode === null) child.kill();
  fs.rmSync(fx.base, { recursive: true, force: true });
});

// The way pi-kanban starts a companion: an explicit port (0 here), loopback, no browser.
function startLikeTheBoard() {
  child = spawn(process.execPath, [SERVER, '--port', '0', '--host', '127.0.0.1', '--no-open'], {
    env: { ...process.env, PI_CODING_AGENT_DIR: fx.agentDir, PI_COST_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no listening line:\n${out}`)), 15_000);
    child.stdout.on('data', (b) => {
      out += b;
      const m = LISTENING.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`exited ${code}:\n${out}`)));
  });
}

describe('embed contract', () => {
  it('prints the listening line, answers /api/companion and writes server.json', async () => {
    const port = await startLikeTheBoard();
    assert.ok(port > 0);
    const res = await fetch(`http://localhost:${port}/api/companion`);
    const body = await res.json();
    assert.equal(body.name, 'pi-cost');
    assert.equal(body.session, '/?session={id}');
    const rec = JSON.parse(fs.readFileSync(path.join(fx.agentDir, 'cost', 'server.json'), 'utf8'));
    assert.equal(rec.port, port);
    assert.equal(rec.pid, child.pid);
    const page = await (await fetch(`http://127.0.0.1:${port}/?session=x&embed=1`)).text();
    assert.match(page, /<script defer src="\/app\.js"/);
  });
});
