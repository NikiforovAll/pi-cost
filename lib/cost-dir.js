'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Files under <agent dir>/cost: settings.json (themes, cli defaults) and server.json, which the
// server writes so the CLI and the pi extension can find it.

function readJson(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`pi-cost: cannot read ${file}: ${e.message}`);
    return {};
  }
}

function readCostSettings(costDir) {
  return readJson(path.join(costDir, 'settings.json'));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A killed server leaves the file behind, so a record counts only while its pid is alive.
function readServerRecord(costDir) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(costDir, 'server.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(rec?.pid) || !Number.isInteger(rec?.port) || !isAlive(rec.pid)) return null;
  return rec;
}

function writeServerRecord(costDir, rec) {
  const file = path.join(costDir, 'server.json');
  try {
    fs.mkdirSync(costDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rec));
  } catch (err) {
    console.warn(`cannot write ${file}: ${err.message}`);
  }
}

// Only the server that wrote the record removes it; a newer server may have replaced it.
function removeServerRecord(costDir, pid) {
  const file = path.join(costDir, 'server.json');
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.unlinkSync(file);
  } catch {}
}

module.exports = { readCostSettings, readServerRecord, writeServerRecord, removeServerRecord, isAlive };
