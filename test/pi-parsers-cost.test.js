'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-symlinks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, 'agent', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const modulePath = require.resolve('../lib/pi-parsers-cost');
  const previous = process.env.PI_DIR;
  process.env.PI_DIR = root;
  delete require.cache[modulePath];
  const parsers = require(modulePath);
  if (previous === undefined) delete process.env.PI_DIR;
  else process.env.PI_DIR = previous;
  return { root, sessions, parsers };
}

function writeSession(dir, name = 'session.jsonl') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({
    type: 'message', id: 'response', timestamp: '2026-10-03T00:00:00Z',
    message: { role: 'assistant', usage: { input: 10, output: 5, cost: { total: 2 } } },
  }) + '\n');
  return fs.realpathSync(file);
}

function link(target, location) {
  fs.symlinkSync(target, location, 'dir');
}

test('discovers sessions behind a project directory symlink', async (t) => {
  const { root, sessions, parsers } = fixture(t);
  const target = path.join(root, 'repository', '.pi', 'sessions');
  const file = writeSession(target);
  link(target, path.join(sessions, '--repository--'));
  const files = await parsers.listSessionFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].file, file);
  assert.equal(files[0].projectDir, '--repository--');
});

test('counts shared worktree stores once and keeps independent stores', async (t) => {
  const { root, sessions, parsers } = fixture(t);
  const target = path.join(root, 'shared');
  writeSession(target);
  link(target, path.join(sessions, '--a-main--'));
  link(target, path.join(sessions, '--b-worktree--'));
  writeSession(path.join(sessions, '--independent--'));
  const files = await parsers.listSessionFiles();
  assert.equal(files.length, 2);
  assert.equal(new Set(files.map((f) => f.file)).size, 2);
  let cost = 0;
  for (const file of files) {
    cost += parsers.summarize(await parsers.readSessionEntriesUncached(file.file)).totalCost;
  }
  assert.equal(cost, 4);
  assert.deepEqual(await parsers.listSessionFiles(), files, 'deduplication resets on every scan');
});

test('prefers a real project directory over its symlink alias', async (t) => {
  const { sessions, parsers } = fixture(t);
  const target = path.join(sessions, '--z-real--');
  writeSession(target);
  link(target, path.join(sessions, '--a-alias--'));
  const files = await parsers.listSessionFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].projectDir, '--z-real--');
});

test('ignores broken links, cyclic links and non-directory targets', async (t) => {
  const { root, sessions, parsers } = fixture(t);
  link(path.join(root, 'missing'), path.join(sessions, '--broken--'));
  link(path.join(sessions, '--cycle--'), path.join(sessions, '--cycle--'));
  const text = path.join(root, 'not-a-directory');
  fs.writeFileSync(text, 'text');
  fs.symlinkSync(text, path.join(sessions, '--file-link--'));
  const file = writeSession(path.join(sessions, '--valid--'));
  assert.deepEqual((await parsers.listSessionFiles()).map((f) => f.file), [file]);
  assert.deepEqual(await parsers.listNestedSubagentFiles(), []);
});

test('discovers nested subagents through shared project links only once', async (t) => {
  const { root, sessions, parsers } = fixture(t);
  const target = path.join(root, 'shared');
  const file = writeSession(path.join(target, 'parent-id', 'run-id', 'run-0'));
  link(target, path.join(sessions, '--a-main--'));
  link(target, path.join(sessions, '--b-worktree--'));
  assert.deepEqual(await parsers.listSessionFiles(), []);
  const files = await parsers.listNestedSubagentFiles();
  assert.equal(files.length, 1);
  assert.equal(files[0].file, file);
  assert.equal(files[0].parentDirName, 'parent-id');
  assert.equal(files[0].runId, 'run-id');
  assert.equal(files[0].attempt, 'run-0');
});

test('returns no sessions when the session root is missing', async (t) => {
  const { sessions, parsers } = fixture(t);
  fs.rmSync(sessions, { recursive: true });
  assert.deepEqual(await parsers.listSessionFiles(), []);
  assert.deepEqual(await parsers.listNestedSubagentFiles(), []);
});
