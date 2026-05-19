import { test as base } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSession, stopSession } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';
import { LanTransport } from '../packages/server/src/transport/LanTransport.js';

interface SessionFixture {
  session: {
    session_id: string;
    public_url: string;
    join_code: string;
    invite_text: string;
    transcriptDir: string;
  };
}

export const test = base.extend<SessionFixture>({
  session: async ({}, use) => {
    const transcriptDir = mkdtempSync(join(tmpdir(), 'sb-e2e-'));
    // Critical: pass copyToClipboard stub so test runs never paste invite text
    // into the developer's OS clipboard.
    const session = await startSession(
      { brief: 'e2e test' },
      {
        transportFactory: 'lan',
        transcriptDir,
        copyToClipboard: async () => null,
      },
    );
    // REL-09 regression guard (Phase 2 / 02-04): LAN mode MUST NOT set
    // `secureCookie:true`, otherwise the e2e fixture would attempt to
    // populate a Secure cookie over plain HTTP and tests would silently
    // drop the participant cookie. Probe a fresh LanTransport (the same
    // class startSession instantiated) to assert its advisory shape; the
    // live transport's state is already in use, so this gives us a clean
    // read without disturbing it.
    const lanProbe = await new LanTransport().start({ host: '0.0.0.0', port: 0 });
    if (lanProbe.secureCookie !== false) {
      throw new Error(
        `LAN fixture regression: LanTransport.secureCookie=${lanProbe.secureCookie}, expected false (REL-09 D-15)`,
      );
    }
    if (lanProbe.bind !== '0.0.0.0') {
      throw new Error(
        `LAN fixture regression: LanTransport.bind=${lanProbe.bind}, expected '0.0.0.0' (REL-08 D-13)`,
      );
    }
    try {
      await use({ ...session, transcriptDir });
    } finally {
      // The mcpState singleton MUST be reset between specs.
      if (mcpState.manager) {
        await stopSession().catch(() => {});
      }
      rmSync(transcriptDir, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';
