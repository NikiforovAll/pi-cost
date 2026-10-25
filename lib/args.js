'use strict';

// `--name value` or `--name=value`. A following flag is not taken as the value.
function getArg(name, argv = process.argv) {
  const idx = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return null;
  const arg = argv[idx];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  const next = argv[idx + 1];
  return next !== undefined && !next.startsWith('--') ? next : null;
}

function hasFlag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

module.exports = { getArg, hasFlag };
