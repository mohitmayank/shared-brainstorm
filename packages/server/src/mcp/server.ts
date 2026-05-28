import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpState } from './state.js';
import {
  startSession,
  askGroup,
  awaitAnswer,
  recordAnswer,
  answerClarification,
  streamPlanning,
  stopSession,
} from './tools.js';
import { openBrowser } from '../util/openBrowser.js';

function textContent(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text }] };
}

function errorContent(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export const TOOLS = [
  {
    name: 'startSession',
    description:
      'Start a new shared-brainstorm session with an approval-gate flow. Returns session_id, public_url, invite_text (a pre-formatted message ready to paste), and coordinator_url (a one-time URL for the initiator to drive the session — opened automatically in their browser, also print it as a fallback). Show the invite_text to the user so they can paste it into Slack/email/etc. Participants join as pending and must be approved by the coordinator.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        brief: {
          type: 'string',
          description: 'Short description of what the session is about.',
        },
      },
      required: ['brief'],
    },
  },
  {
    name: 'askGroup',
    description:
      'Post a question to the room. The question is broadcast immediately to all joined participants. Returns a ticket_id to poll for discussion via awaitAnswer. ' +
      'Redaction is best-effort (regex + entropy heuristics, not a security guarantee) — keep secrets out of question text. ' +
      'Set SHARED_BRAINSTORM_NO_REDACT=1 to disable.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question to ask the group.' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['label'],
          },
          description: 'Optional list of options (for multiple-choice questions).',
        },
        recommendation: {
          type: 'string',
          description: "AI host's recommendation, shown to participants alongside the question.",
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'awaitAnswer',
    description:
      'Block up to timeout_s seconds for the question to be discussed, then return a snapshot of suggestions and comments accumulated so far. Empty arrays mean no input yet. The ticket stays open across polls — call again to wait for more, or call recordAnswer to commit the final pick.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticket_id: { type: 'string', description: 'The ticket_id returned by askGroup.' },
        timeout_s: {
          type: 'number',
          description: 'How many seconds to wait (1–55, default 50).',
        },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'recordAnswer',
    description:
      "Record the initiator's final pick for the current question. Resolves the ticket and writes the decision to the transcript. Call this AFTER presenting the team's discussion to the initiator and getting their choice (via AskUserQuestion in the AI CLI).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticket_id: { type: 'string', description: 'The ticket_id returned by askGroup.' },
        value: {
          type: 'string',
          description: 'The final answer the initiator chose.',
        },
        source: {
          type: 'string',
          enum: ['suggestion', 'synthesis', 'override'],
          description:
            "Provenance: 'suggestion' if a participant's verbatim suggestion was chosen, 'synthesis' if the AI synthesised an answer from multiple suggestions, 'override' if the initiator wrote a new answer.",
        },
      },
      required: ['ticket_id', 'value', 'source'],
    },
  },
  {
    name: 'answerClarification',
    description:
      'Record the AI host\'s answer to a participant\'s clarifying question. ' +
      'Finds the clarification by `clarification_id` on the question identified by `ticket_id`, ' +
      'sets the answer text, and re-emits `clarification_added` so the browser updates in real time. ' +
      'Call this when a participant has asked a clarification via the "Ask the AI" input on the question card.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ticket_id: {
          type: 'string',
          description: 'The ticket_id of the question that has the clarification.',
        },
        clarification_id: {
          type: 'string',
          description: 'The clarification_id surfaced in the awaitAnswer clarifications[] array.',
        },
        text: {
          type: 'string',
          description: 'The AI answer to the clarification (1–4000 characters).',
        },
      },
      required: ['ticket_id', 'clarification_id', 'text'],
    },
  },
  {
    name: 'streamPlanning',
    description:
      'Stream a short line of your planning narration to the team web view as you think. ' +
      'Call this periodically while planning (one concise sentence per call — what you are ' +
      'considering, weighing, or about to do), NOT verbose output or code. Off by default: ' +
      'the coordinator opts in per session and chooses the audience, so a returned ' +
      '`streamed:false` means it is disabled right now — stop narrating until it changes. ' +
      'Text is redacted best-effort before broadcast; keep secrets out. Globally disabled with ' +
      'SHARED_BRAINSTORM_NO_STREAM=1.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'One concise line of planning narration (1–4000 characters).',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'stopSession',
    description: 'End the active session, write the transcript, and clean up resources.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
] as const;

export function runMcpStdio(): void {
  const server = new Server(
    { name: 'shared-brainstorm', version: '0.1.0' },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const raw: unknown = args ?? {};

    try {
      switch (name) {
        case 'startSession': {
          // Inject the REAL browser launcher here, at the production composition
          // root — NOT as a default inside startSession, so importing/testing
          // startSession never spawns a browser tab.
          const result = await startSession(raw, { openBrowser });
          return textContent(JSON.stringify(result));
        }
        case 'askGroup': {
          const result = askGroup(raw);
          return textContent(JSON.stringify(result));
        }
        case 'awaitAnswer': {
          const result = await awaitAnswer(raw);
          return textContent(JSON.stringify(result));
        }
        case 'recordAnswer': {
          const result = recordAnswer(raw);
          return textContent(JSON.stringify(result));
        }
        case 'answerClarification': {
          const result = answerClarification(raw);
          return textContent(JSON.stringify(result));
        }
        case 'streamPlanning': {
          const result = streamPlanning(raw);
          return textContent(JSON.stringify(result));
        }
        case 'stopSession': {
          const result = await stopSession();
          return textContent(JSON.stringify(result));
        }
        default:
          return errorContent(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return errorContent(err);
    }
  });

  server.onclose = () => {
    if (mcpState.manager) {
      const transport = mcpState.transport;
      const http = mcpState.http;
      mcpState.manager.stop('ai_host_disconnected');
      mcpState.manager = null;
      mcpState.transport = null;
      mcpState.http = null;
      mcpState.publicUrl = null;
      mcpState.transportFailed = false;
      mcpState.lastTransportError = null;
      transport?.stop().catch(() => {});
      http?.close().catch(() => {});
    }
  };

  const transport = new StdioServerTransport();
  void server.connect(transport);
}
