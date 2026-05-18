import type { SessionManager } from '../session/SessionManager.js';
import type { Transport } from '../transport/Transport.js';
import type { RunningServer } from '../http/index.js';

export interface McpState {
  manager: SessionManager | null;
  transport: Transport | null;
  http: RunningServer | null;
  publicUrl: string | null;
}

export const mcpState: McpState = {
  manager: null,
  transport: null,
  http: null,
  publicUrl: null,
};
