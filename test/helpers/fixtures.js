'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IDS = {
  alpha: '00000000-0000-4000-8000-0000000000a1',
  beta: '00000000-0000-4000-8000-0000000000b2',
  run: '00000000-0000-4000-8000-0000000000c3',
  gamma: '00000000-0000-4000-8000-0000000000d4',
};

const ALPHA_TURNS = 30;
const TURN_COST = 0.001;
const COMPACTION_COST = 0.002;
const RUN_COST = 0.003;
const GAMMA_COST = 0.005;

const usage = (cost, extra = {}) => ({
  input: 10, output: 20, cacheRead: 100, cacheWrite: 5, totalTokens: 135,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  ...extra,
});

const writeJsonl = (file, entries) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
};

const stamp = (iso) => iso.replace(/[:.]/g, '-');

function assistant(id, ts, cost, content = [{ type: 'text', text: 'ok' }], provider = 'codemie', model = 'gpt-6-luna') {
  return { type: 'message', id, timestamp: ts, message: { role: 'assistant', content, provider, model, usage: usage(cost), durationMs: 1200 } };
}

/**
 * Synthetic agent dir with no real data:
 * - alpha (nested dir): 30 recorded turns, one compaction with usage, one subagent run whose
 *   nested session sits under <alpha basename>/<runId>/0/session.jsonl
 * - beta (nested dir): a fork of alpha with one turn priced from LiteLLM (cost 0 in the file)
 * - gamma (flat custom dir): one recorded turn
 */
function buildFixture(base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cost-test-'))) {
  const agentDir = path.join(base, 'agent');
  const flatDir = path.join(base, 'flat-sessions');
  const alphaCwd = path.join(base, 'work', 'alpha');
  const betaCwd = path.join(base, 'work', 'beta');
  const gammaCwd = path.join(base, 'work', 'gamma');
  const enc = (cwd) => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

  const t0 = Date.now() - 3 * 60 * 60 * 1000;
  const at = (min) => new Date(t0 + min * 60 * 1000).toISOString();

  const alphaFile = path.join(agentDir, 'sessions', enc(alphaCwd), `${stamp(at(0))}_${IDS.alpha}.jsonl`);
  const runFile = path.join(path.dirname(alphaFile), path.basename(alphaFile, '.jsonl'), 'run-1', '0', 'session.jsonl');
  const alpha = [
    { type: 'session', version: 3, id: IDS.alpha, timestamp: at(0), cwd: alphaCwd },
    { type: 'session_info', name: 'Alpha work' },
    { type: 'model_change', id: 'mc1', timestamp: at(0), provider: 'codemie', modelId: 'gpt-6-luna' },
    { type: 'message', id: 'u1', timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: 'start alpha' }] } },
  ];
  for (let i = 1; i <= ALPHA_TURNS; i++) {
    const content = i === 1 ? [{ type: 'toolCall', name: 'read' }, { type: 'toolCall', name: 'bash' }] : undefined;
    alpha.push(assistant(`a${i}`, at(i), TURN_COST, content));
  }
  alpha.push({ type: 'compaction', id: 'c1', timestamp: at(31), summary: 'summary', firstKeptEntryId: 'a20', tokensBefore: 50000, usage: usage(COMPACTION_COST) });
  alpha.push({
    type: 'message', id: 't1', timestamp: at(32),
    message: {
      role: 'toolResult', toolName: 'subagent', content: [],
      details: { runId: 'run-1', results: [{ agent: 'scout', task: '[prompt redacted]', model: 'codemie/gpt-6-luna', usage: usage(RUN_COST, { turns: 2 }), sessionFile: runFile, exitCode: 0 }] },
    },
  });
  writeJsonl(alphaFile, alpha);

  writeJsonl(runFile, [
    { type: 'session', version: 3, id: IDS.run, timestamp: at(32), cwd: alphaCwd },
    { type: 'message', id: 'r1', timestamp: at(32), message: { role: 'user', content: 'scout task' } },
    assistant('r2', at(32), RUN_COST),
  ]);

  const betaFile = path.join(agentDir, 'sessions', enc(betaCwd), `${stamp(at(40))}_${IDS.beta}.jsonl`);
  writeJsonl(betaFile, [
    { type: 'session', version: 3, id: IDS.beta, timestamp: at(40), cwd: betaCwd, parentSession: alphaFile },
    { type: 'message', id: 'u1', timestamp: at(40), message: { role: 'user', content: 'fork' } },
    { type: 'message', id: 'b1', timestamp: at(41), message: { role: 'assistant', content: [], provider: 'github-copilot', model: 'claude-sonnet-4.5', usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { total: 0 } } } },
  ]);

  const gammaFile = path.join(flatDir, `${stamp(at(50))}_${IDS.gamma}.jsonl`);
  writeJsonl(gammaFile, [
    { type: 'session', version: 3, id: IDS.gamma, timestamp: at(50), cwd: gammaCwd },
    { type: 'message', id: 'u1', timestamp: at(50), message: { role: 'user', content: 'flat' } },
    assistant('g1', at(51), GAMMA_COST),
  ]);

  return {
    base,
    agentDir,
    flatDir,
    files: { alpha: alphaFile, beta: betaFile, run: runFile, gamma: gammaFile },
    projects: { alpha: enc(alphaCwd), beta: enc(betaCwd), gamma: enc(gammaCwd) },
    expected: {
      alphaTurns: ALPHA_TURNS,
      alphaCost: ALPHA_TURNS * TURN_COST + COMPACTION_COST + RUN_COST,
      recordedCost: ALPHA_TURNS * TURN_COST + COMPACTION_COST + RUN_COST + GAMMA_COST,
      runCost: RUN_COST,
      compactionCost: COMPACTION_COST,
      gammaCost: GAMMA_COST,
    },
  };
}

module.exports = { IDS, buildFixture };
