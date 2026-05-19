import { describe, expect, it, vi, afterEach } from 'vitest';
import { redactText, redactQuestion } from './redact.js';

describe('redactText — paths', () => {
  it('redacts absolute unix paths', () => {
    expect(redactText('check /home/alice/secrets/key.pem and /etc/passwd')).toBe(
      'check <PATH> and <PATH>',
    );
  });

  it('redacts a single home path with dot-prefixed segment', () => {
    expect(redactText('see /home/alice/.ssh/id_rsa now')).toBe('see <PATH> now');
  });

  it('redacts windows paths', () => {
    expect(redactText('open C:\\Users\\alice\\creds.txt')).toBe('open <PATH>');
  });

  it('preserves single-segment paths like /api, /health, /join', () => {
    expect(redactText('use /api endpoint')).toBe('use /api endpoint');
    expect(redactText('check /health for monitoring')).toBe('check /health for monitoring');
    expect(redactText('call /join to register')).toBe('call /join to register');
  });
});

describe('redactText — tokens', () => {
  it('redacts AWS-style access keys', () => {
    expect(redactText('use AKIAIOSFODNN7EXAMPLE for ci')).toBe('use <TOKEN> for ci');
  });

  it('redacts long hex tokens (>=24 chars, mixed digit+letter)', () => {
    expect(redactText('tok=abc123def456ghi789jkl012mno345')).toBe('tok=<TOKEN>');
  });

  it('redacts a 32-char hex string with mixed digits and letters', () => {
    // 32 hex chars, has digits and letters, high entropy
    expect(redactText('hash 9f86d081884c7d659a2feaa0c55ad015 here')).toBe('hash <TOKEN> here');
  });

  it('redacts a base64-shaped 30+ char string with mixed digits and letters', () => {
    // 32 chars, mixed alnum and base64 separators, high entropy
    expect(redactText('jwt aB3dEf7gHi9JkLmN0pQrStUvWxYz12cD here')).toBe('jwt <TOKEN> here');
  });
});

describe('redactText — env vars (allowlisted prefixes)', () => {
  it('redacts env-var assignments inline (DATABASE_URL)', () => {
    expect(redactText('DATABASE_URL=postgres://u:p@host/db is set')).toBe(
      '<ENV>=<TOKEN> is set',
    );
  });

  it('redacts API_KEY=… assignments', () => {
    expect(redactText('API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa')).toBe('<ENV>=<TOKEN>');
  });

  it('redacts AWS_SECRET_ACCESS_KEY=… assignments', () => {
    expect(
      redactText('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'),
    ).toBe('<ENV>=<TOKEN>');
  });

  it('redacts env vars with _KEY suffix even if prefix is unknown', () => {
    // STRIPE_KEY ends with _KEY → allowlisted via suffix
    expect(redactText('STRIPE_KEY=sk_live_abcdefghijklmnopqrstuvwx')).toBe('<ENV>=<TOKEN>');
  });
});

describe('redactText — calibration: must NOT redact', () => {
  it('preserves "use Postgres for storage..." sentences', () => {
    expect(redactText('use Postgres for storage; team familiar with it')).toBe(
      'use Postgres for storage; team familiar with it',
    );
  });

  it('does not redact "this is a perfectly normal sentence that is long enough"', () => {
    expect(redactText('this is a perfectly normal sentence that is long enough')).toBe(
      'this is a perfectly normal sentence that is long enough',
    );
  });

  it('does not redact "the quick brown fox jumps over the lazy dog"', () => {
    expect(redactText('the quick brown fox jumps over the lazy dog')).toBe(
      'the quick brown fox jumps over the lazy dog',
    );
  });

  it('does not redact "committee meeting notes v2"', () => {
    expect(redactText('committee meeting notes v2')).toBe('committee meeting notes v2');
  });

  it('does not redact code identifier "committee_meeting_notes_v2"', () => {
    // 26 chars, has digit + letter, but low entropy / dictionary-like
    expect(redactText('committee_meeting_notes_v2')).toBe('committee_meeting_notes_v2');
  });

  it('does not redact "USER agreement applies"', () => {
    expect(redactText('USER agreement applies')).toBe('USER agreement applies');
  });

  it('does not redact "BRIEF=auth flow" (no allowlisted prefix/suffix)', () => {
    expect(redactText('BRIEF=auth flow')).toBe('BRIEF=auth flow');
  });
});

describe('redactQuestion', () => {
  it('returns redacted copy preserving structure (plan example)', () => {
    const r = redactQuestion({
      question: 'Should we store keys at /home/alice/.ssh/id_rsa?',
      options: [{ label: 'Use AKIAEXAMPLEEXAMPLEAA', description: 'aws prod' }],
      recommendation: 'API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(r.question).toBe('Should we store keys at <PATH>?');
    expect(r.options?.[0]?.label).toBe('Use <TOKEN>');
    expect(r.options?.[0]?.description).toBe('aws prod');
    expect(r.recommendation).toBe('<ENV>=<TOKEN>');
  });

  it('round-trip: scrubs path in question, token in option label, env in recommendation', () => {
    const input = {
      question: 'Open /home/alice/.ssh/id_rsa for deploy?',
      options: [
        {
          label: 'Use AKIAIOSFODNN7EXAMPLE',
          description: 'no secrets here',
        },
      ],
      recommendation: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    };
    const r = redactQuestion(input);
    expect(r.question).toBe('Open <PATH> for deploy?');
    expect(r.options?.[0]?.label).toBe('Use <TOKEN>');
    expect(r.options?.[0]?.description).toBe('no secrets here');
    expect(r.recommendation).toBe('<ENV>=<TOKEN>');
  });

  it('omits options when input has none', () => {
    const r = redactQuestion({ question: 'just a question' });
    expect(r.options).toBeUndefined();
    expect(r.recommendation).toBeUndefined();
  });
});

describe('redactQuestion — SHARED_BRAINSTORM_NO_REDACT opt-out', () => {
  const ORIGINAL = process.env['SHARED_BRAINSTORM_NO_REDACT'];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['SHARED_BRAINSTORM_NO_REDACT'];
    else process.env['SHARED_BRAINSTORM_NO_REDACT'] = ORIGINAL;
    vi.resetModules();
  });

  it('is pass-through when env var is set to "1"', async () => {
    process.env['SHARED_BRAINSTORM_NO_REDACT'] = '1';
    vi.resetModules();
    const { redactQuestion: rq } = await import('./redact.js');
    const out = rq({
      question: 'Open /home/alice/.ssh/id_rsa?',
      recommendation: 'API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(out.question).toBe('Open /home/alice/.ssh/id_rsa?');
    expect(out.recommendation).toBe('API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('preserves options array shape when opt-out is active', async () => {
    process.env['SHARED_BRAINSTORM_NO_REDACT'] = 'true';
    vi.resetModules();
    const { redactQuestion: rq } = await import('./redact.js');
    const input = {
      question: 'q?',
      options: [{ label: 'AKIAIOSFODNN7EXAMPLE', description: 'aws' }],
    };
    const out = rq(input);
    expect(out.options).toEqual(input.options);
  });

  it('honors case-insensitive truthy values', async () => {
    for (const val of ['1', 'true', 'TRUE', 'yes', 'on', ' YES ']) {
      process.env['SHARED_BRAINSTORM_NO_REDACT'] = val;
      vi.resetModules();
      const { redactQuestion: rq } = await import('./redact.js');
      const out = rq({ question: 'Open /home/alice/.ssh/id_rsa?' });
      expect(out.question, `failed for value: "${val}"`).toBe('Open /home/alice/.ssh/id_rsa?');
    }
  });

  it('still redacts when env var is unset (regression guard)', async () => {
    delete process.env['SHARED_BRAINSTORM_NO_REDACT'];
    vi.resetModules();
    const { redactQuestion: rq } = await import('./redact.js');
    const out = rq({ question: 'check /home/alice/.ssh/id_rsa' });
    expect(out.question).toContain('<PATH>');
  });

  it('is full redaction when env var is set to "0" or "false"', async () => {
    for (const val of ['0', 'false', 'no', 'off', '']) {
      process.env['SHARED_BRAINSTORM_NO_REDACT'] = val;
      vi.resetModules();
      const { redactQuestion: rq } = await import('./redact.js');
      const out = rq({ question: 'check /home/alice/.ssh/id_rsa' });
      expect(out.question, `should still redact for value: "${val}"`).toContain('<PATH>');
    }
  });
});
