'use strict';

// Network boundary for a local-only server, adapted from claude-code-cost.
//
// Binding loopback stops LAN peers. Two attacks still reach a loopback bind:
//   * DNS rebinding: a page on evil.com re-resolves its name to 127.0.0.1 and reads the API
//     same-origin. Only the Host header differs, and script cannot forge it, so Host is allowlisted.
//   * CSRF: evil.com POSTs straight at 127.0.0.1. Host is real, so state-changing methods also need
//     a loopback Origin (or no Origin and no cross-site Sec-Fetch-Site).
//
// pi-kanban frames this page from its own loopback port, which is dynamic, so any loopback port
// may frame it and X-Frame-Options (which has no multi-origin form) is not sent.

const http = require('node:http');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']);
const PORT_RE = /^[0-9]{1,5}$/;
const validPort = (p) => PORT_RE.test(p) && Number(p) >= 1 && Number(p) <= 65535;
const KEEP_ALIVE_MS = 65000;
// A whole IPv4 literal: a prefix test would let a rebinding name like 127.evil.com through.
const LOOPBACK_V4_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// Chrome rejects an IPv6 literal as a frame-ancestors source.
const FRAME_CSP = "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*";

function isLoopbackAddress(host) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return LOOPBACK_HOSTS.has(h) || LOOPBACK_V4_RE.test(h);
}

// Hand-parsed: new URL() accepts far more than a real client sends. Returns the lowercased
// hostname, or null when malformed. The port is not compared, because a busy port falls back to a
// random one.
function parseHostHeader(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 259) return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return null;
  }
  if (raw.includes('@')) return null;

  let host;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return null;
    host = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest && !(rest.startsWith(':') && validPort(rest.slice(1)))) return null;
  } else {
    const parts = raw.split(':');
    if (parts.length > 2) return null;
    host = parts[0];
    if (parts.length === 2 && !validPort(parts[1])) return null;
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return null;
  return host.toLowerCase();
}

function parseList(value) {
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {{appName?: string, bindHost?: string, allowedHosts?: string}} [config]
 */
function createNetGuard(config = {}) {
  const appName = config.appName || 'This app';
  const BIND_HOST = config.bindHost || '127.0.0.1';
  const BIND_HOST_LC = BIND_HOST.toLowerCase();
  const EXPOSED = !isLoopbackAddress(BIND_HOST);
  const extraHosts = new Set(parseList(config.allowedHosts));
  let actualPort = null;

  function hostAllowed(host) {
    if (!host) return false;
    if (isLoopbackAddress(host) || extraHosts.has(host)) return true;
    return EXPOSED && host === BIND_HOST_LC;
  }

  function hostGuard(req, res, next) {
    const host = parseHostHeader(req.headers.host);
    if (hostAllowed(host)) return next();
    res.status(403).type('text/plain').send(
      `403 Forbidden - unrecognized Host header: ${req.headers.host || '(none)'}\n\n` +
      `${appName} only answers requests addressed to localhost. This protects you from DNS\n` +
      `rebinding, where a website re-points its own hostname at 127.0.0.1 to read local data.\n\n` +
      `To reach it from another machine, restart with:\n` +
      `  --host 0.0.0.0 --allowed-hosts=${host || '<your-hostname>'}\n\n` +
      `Only do that on a network you trust - there is no authentication.\n`,
    );
  }

  // true = allow, false = block, null = no Origin header.
  function originVerdict(origin) {
    if (!origin || origin === 'null') return null;
    let parsed;
    try { parsed = new URL(origin); } catch { return false; }
    if (!isLoopbackAddress(parsed.hostname)) return false;
    // A different local port is a different app and has no business driving this one.
    if (actualPort && parsed.port && Number(parsed.port) !== Number(actualPort)) return false;
    return true;
  }

  function originGuard(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const verdict = originVerdict(req.headers.origin);
    if (verdict === true) return next();
    if (verdict === false) {
      return res.status(403).type('text/plain')
        .send(`403 Forbidden - cross-origin ${req.method} from ${req.headers.origin} is not allowed.\n`);
    }
    // No Origin: a non-browser client (curl, the CLI). Trust it unless the browser says otherwise.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') {
      return res.status(403).type('text/plain')
        .send(`403 Forbidden - cross-site ${req.method} (Sec-Fetch-Site: ${site}) is not allowed.\n`);
    }
    return next();
  }

  function frameGuard(_req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', FRAME_CSP);
    next();
  }

  /**
   * Bind BIND_HOST, then serve the other loopback family on the same port, so
   * http://localhost:<port> works whichever family the resolver returns first. A family the host
   * does not have is skipped. If another process holds the port on the other family, the primary
   * closes and emits EADDRINUSE, because that process would answer localhost:<port> in our name.
   * @returns {http.Server} the primary server; attach the 'error' handler to it.
   */
  function listenLoopback(app, port, onReady, opts = {}) {
    const serverOpts = opts.maxHeaderSize ? { maxHeaderSize: opts.maxHeaderSize } : {};
    const makeServer = () => {
      const s = http.createServer(serverOpts, app);
      s.keepAliveTimeout = KEEP_ALIVE_MS;
      return s;
    };
    const server = makeServer();
    let secondary = null;
    let randomTries = 0;

    server.on('listening', () => {
      const boundPort = server.address().port;
      actualPort = boundPort;
      const ready = () => { if (onReady) onReady(boundPort); };
      if (EXPOSED) return ready();
      const otherFamily = BIND_HOST.includes(':') ? '127.0.0.1' : '::1';
      secondary = makeServer();
      secondary.once('listening', ready);
      secondary.on('error', (err) => {
        if (err.code !== 'EADDRINUSE') return ready();
        if (port === 0 && ++randomTries < 5) return server.close(() => server.listen(0, BIND_HOST));
        server.close();
        server.emit('error', err);
      });
      secondary.listen({ host: otherFamily, port: boundPort, ipv6Only: otherFamily === '::1' });
    });
    server.on('close', () => { if (secondary) secondary.close(() => {}); });

    server.listen(port, BIND_HOST);
    return server;
  }

  function exposureWarning() {
    return EXPOSED ? `WARNING: listening on ${BIND_HOST} - reachable from your network, with no authentication.` : null;
  }

  return { BIND_HOST, EXPOSED, hostGuard, originGuard, frameGuard, listenLoopback, exposureWarning };
}

module.exports = { createNetGuard, parseHostHeader, isLoopbackAddress, FRAME_CSP, KEEP_ALIVE_MS };
