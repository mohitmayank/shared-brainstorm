/**
 * THROWAWAY UAT harness for the planning-stream feature (not shipped).
 * Hosts a real shared-brainstorm session in LAN mode and exposes agent-side
 * actions via a file command-queue so the planning-stream flow can be driven
 * step-by-step from another shell while we watch the browser.
 *
 * Run:  npx tsx scripts/uat-planning-stream.mts
 * Drive: append JSON lines to /tmp/sb-uat-cmd.jsonl, e.g.
 *   {"cmd":"push","text":"Weighing token bucket vs sliding window"}
 *   {"cmd":"stop"}
 * Read:  /tmp/sb-uat-state.json (session urls), /tmp/sb-uat-log.txt (action log)
 *
 * The HTTP `POST /api/coordinator/stream` endpoint and the web UI control the
 * audience mode (off / coordinator / everyone) — that we drive from the browser.
 */
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startSession, streamPlanning, stopSession } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';

const CMD = '/tmp/sb-uat-cmd.jsonl';
const LOG = '/tmp/sb-uat-log.txt';
const STATE = '/tmp/sb-uat-state.json';
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
  { brief: 'Planning-stream UAT — audience-gated narration demo' },
  {
    transportFactory: 'lan',
    staticDir: WEB_DIST,
    openBrowser: async () => null,
    copyToClipboard: async () => false,
  },
);
writeFileSync(STATE, JSON.stringify(session, null, 2));
log('SESSION', session);
log('STREAM_MODE_INITIAL', mcpState.manager?.getStreamMode());

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
      if (cmd.cmd === 'push') {
        const out = streamPlanning({ text: cmd.text });
        log('PUSH', { in: cmd.text, out });
      } else if (cmd.cmd === 'mode') {
        // Server-side mode change (parallel to the browser button) — useful
        // for asserting clean upgrade/downgrade buffer-clear semantics without
        // a coordinator browser yet present.
        mcpState.manager?.setStreamMode(cmd.mode as 'off' | 'coordinator' | 'everyone');
        log('MODE', { mode: cmd.mode, now: mcpState.manager?.getStreamMode() });
      } else if (cmd.cmd === 'snapshot') {
        log('SNAPSHOT', {
          mode: mcpState.manager?.getStreamMode(),
          forCoord: mcpState.manager?.currentStreamState(true),
          forParticipant: mcpState.manager?.currentStreamState(false),
        });
      } else if (cmd.cmd === 'stop') {
        const out = await stopSession();
        log('STOP_OK', out);
        process.exit(0);
      }
    } catch (e) {
      log('ERR', String(e));
    }
  }
  await sleep(200);
}
