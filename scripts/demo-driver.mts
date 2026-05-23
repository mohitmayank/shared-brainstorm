/**
 * THROWAWAY demo harness (not shipped). Hosts a real shared-brainstorm session
 * in LAN mode and exposes agent-side actions via a file command-queue so the
 * demo video can be choreographed step-by-step.
 *
 * Run:  npx tsx scripts/demo-driver.mts
 * Drive: append JSON lines to /tmp/sb-cmd.jsonl, e.g.
 *   {"cmd":"ask","question":"...","options":[{"label":"Redis"},{"label":"Postgres"}]}
 *   {"cmd":"await","ticket_id":"...","timeout_s":3}
 *   {"cmd":"stop"}
 * Read:  /tmp/sb-state.json (session urls), /tmp/sb-log.txt (action log)
 */
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startSession, askGroup, awaitAnswer, stopSession } from '../packages/server/src/mcp/tools.js';

const CMD = '/tmp/sb-cmd.jsonl';
const LOG = '/tmp/sb-log.txt';
const STATE = '/tmp/sb-state.json';
const WEB_DIST = '/home/files/git/mohit/shared-brainstorm/packages/web/dist';

writeFileSync(CMD, '');
writeFileSync(LOG, '');

function log(label: string, obj?: unknown): void {
  const line = `[${new Date().toISOString()}] ${label} ${obj !== undefined ? JSON.stringify(obj) : ''}`;
  appendFileSync(LOG, line + '\n');
  // eslint-disable-next-line no-console
  console.log(line);
}

const session = await startSession(
  { brief: 'Auth flow for the new API — how should we store sessions?' },
  { transportFactory: 'lan', staticDir: WEB_DIST, copyToClipboard: async () => false },
);
writeFileSync(STATE, JSON.stringify(session, null, 2));
log('SESSION', session);

let processed = 0;
// eslint-disable-next-line no-constant-condition
while (true) {
  let lines: string[] = [];
  try {
    lines = readFileSync(CMD, 'utf8').split('\n').filter(Boolean);
  } catch {
    /* file may not exist yet */
  }
  for (; processed < lines.length; processed++) {
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(lines[processed]!);
    } catch {
      continue;
    }
    try {
      if (cmd.cmd === 'ask') {
        const arg: Record<string, unknown> = { question: cmd.question };
        if (cmd.options) arg.options = cmd.options;
        if (cmd.recommendation) arg.recommendation = cmd.recommendation;
        const out = askGroup(arg);
        log('ASK_OK', out);
      } else if (cmd.cmd === 'await') {
        const out = await awaitAnswer({ ticket_id: cmd.ticket_id, timeout_s: cmd.timeout_s ?? 5 });
        log('AWAIT_OK', out);
      } else if (cmd.cmd === 'stop') {
        const out = await stopSession();
        log('STOP_OK', out);
        process.exit(0);
      }
    } catch (e) {
      log('ERR', String(e));
    }
  }
  await sleep(400);
}
