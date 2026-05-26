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
    invite_text: string;
    transcriptDir: string;
    // 03-06: the coordinator surface (parallel to public_url). `coordinator_url`
    // comes straight off the startSession output (added in 03-01) and carries
    // `?role=coordinator&token=<22>`; `coordinator_token` is parsed back out of
    // that URL so each coordinator spec can assert the URL actually carries the
    // token without re-reading mcpState. The token is NEVER logged to stdout.
    coordinator_url: string;
    coordinator_token: string;
  };
}

export const test = base.extend<SessionFixture>({
  session: async ({}, use) => {
    const transcriptDir = mkdtempSync(join(tmpdir(), 'sb-e2e-'));
    // Critical: pass an openBrowser stub so test runs never launch a real
    // browser against the developer's machine.
    const session = await startSession(
      { brief: 'e2e test' },
      {
        transportFactory: 'lan',
        transcriptDir,
        openBrowser: async () => null,
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
    // 03-06: derive coordinator_token by parsing the `token` query param out of
    // coordinator_url — this asserts the URL itself carries the token (rather
    // than reading mcpState.manager!.coordinatorToken() directly, which would
    // not prove the URL shape). The token must stay off stdout.
    const coordinator_url = session.coordinator_url;
    const coordinator_token = new URL(coordinator_url).searchParams.get('token');
    if (!coordinator_token) {
      throw new Error(
        'coordinator fixture regression: coordinator_url is missing the ?token= query param',
      );
    }
    try {
      await use({ ...session, transcriptDir, coordinator_url, coordinator_token });
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
