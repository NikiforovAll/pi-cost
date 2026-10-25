#!/usr/bin/env node
'use strict';

const { getArg, hasFlag } = require('./lib/args');
const parsers = require('./lib/pi-parsers-cost');

parsers.configure({ sessionDir: getArg('session-dir') });

const cli = require('./lib/cli');
if (cli.isCommand(process.argv[2])) {
  cli.main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
} else {
  startServer();
}

function startServer() {
  const pricing = require('./lib/pi-pricing');
  const { createApp } = require('./lib/app');
  const { createNetGuard } = require('./lib/net-guard');
  const { createThemeStore } = require('./lib/themes');
  const { writeServerRecord, removeServerRecord } = require('./lib/cost-dir');

  const portArg = getArg('port');
  const PORT = parseInt(portArg || process.env.PORT || '5461', 10);
  // An explicit --port binds exactly, so a host that picked the port (pi-kanban) can rely on it.
  const STRICT_PORT = portArg !== null;
  const OPEN = hasFlag('open') && !hasFlag('no-open');
  const COST_DIR = parsers.getCostDir();

  const net = createNetGuard({
    appName: 'pi-cost',
    bindHost: getArg('host') || process.env.HOST || '127.0.0.1',
    allowedHosts: getArg('allowed-hosts') || process.env.ALLOWED_HOSTS || '',
  });
  const themes = createThemeStore(COST_DIR);
  const app = createApp({ net, themes });

  themes.ready.then(() => console.log(`themes loaded: ${themes.themes.size} (user dir: ${themes.config.dir})`));

  process.on('exit', () => removeServerRecord(COST_DIR, process.pid));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  const onReady = (port) => {
    console.log(`pi-cost listening on http://localhost:${port}`);
    console.log(`Sessions dir: ${parsers.getSessionRoots().map((r) => r.dir).join(', ')}`);
    const warning = net.exposureWarning();
    if (warning) console.log(warning);
    writeServerRecord(COST_DIR, { pid: process.pid, port, sessionRoots: parsers.getSessionRoots() });
    if (OPEN) import('open').then((mod) => mod.default(`http://localhost:${port}`)).catch(() => {});
  };

  const listen = (port) => {
    const server = net.listenLoopback(app, port, onReady, { maxHeaderSize: 32768 });
    server.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') throw err;
      if (STRICT_PORT) {
        console.error(`Port ${port} in use`);
        process.exit(1);
      }
      console.log(`Port ${port} in use, trying random port...`);
      listen(0);
    });
  };

  listen(PORT);
  pricing.fetchPricing()
    .then(() => {
      const meta = pricing.getMeta();
      console.log(`pricing: ${meta.modelCount} models (${meta.source})`);
    })
    .catch(() => {});
}
