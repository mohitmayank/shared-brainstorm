import { test as base } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSession, stopSession } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';

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
