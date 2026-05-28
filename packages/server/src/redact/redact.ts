import type { AskGroupInput } from '@shared-brainstorm/shared';
import { isTruthyEnv } from '../util/env.js';

const REDACTION_DISABLED = isTruthyEnv(process.env['SHARED_BRAINSTORM_NO_REDACT']);

/**
 * Best-effort scrub of paths, env-var assignments, and high-entropy tokens.
 * Coordinator preview is the safety net; this is defense-in-depth.
 *
 * Rule order matters: env-var assignments are matched BEFORE the generic
 * long-token rule so the value half is consumed by `<ENV>=<TOKEN>` instead
 * of being independently rewritten to `<TOKEN>` (leaving the env name bare).
 *
 * Hardening (errata E19):
 *  - env-var rule fires only when preceded by line-start, whitespace, or
 *    one of the boundary chars `\`'":,;`, AND the env name has a known
 *    sensitive prefix or suffix (allowlist).
 *  - generic long-token rule fires only on candidates >=24 chars containing
 *    BOTH at least one digit AND at least one letter, plus a low-effort
 *    entropy heuristic (distinct-char-count >= 8 OR distinct/length >= 0.4).
 *    This avoids redacting English sentences and snake_case identifiers
 *    while still catching AKIA-shaped, hex, and base64 secrets.
 */

const ENV_PREFIXES = [
  'AWS_',
  'API_',
  'DATABASE_',
  'DB_',
  'SECRET_',
  'TOKEN_',
  'KEY_',
  'PASSWORD_',
  'JWT_',
  'SESSION_',
  'OAUTH_',
  'STRIPE_',
  'GH_',
  'GITHUB_',
  'OPENAI_',
  'ANTHROPIC_',
];

const ENV_SUFFIXES = ['_KEY', '_TOKEN', '_SECRET', '_PASSWORD', '_PASS'];

function isAllowlistedEnvName(name: string): boolean {
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(name)) return false;
  for (const p of ENV_PREFIXES) {
    if (name.startsWith(p)) return true;
  }
  for (const s of ENV_SUFFIXES) {
    if (name.endsWith(s)) return true;
  }
  return false;
}

function looksHighEntropy(token: string): boolean {
  if (token.length < 24) return false;
  let hasLetter = false;
  let digitCount = 0;
  const seen = new Set<string>();
  for (const ch of token) {
    if (/[A-Za-z]/.test(ch)) hasLetter = true;
    if (/\d/.test(ch)) digitCount += 1;
    seen.add(ch);
  }
  if (!hasLetter) return false;

  const distinct = seen.size;
  const ratio = distinct / token.length;
  const digitRatio = digitCount / token.length;

  // All-alpha tokens (e.g. ghp_/github_pat_ style): only redact if
  // character diversity is very high (>= 50% unique chars). English words
  // and code identifiers reuse letters heavily; random tokens don't.
  if (digitCount === 0) {
    return ratio >= 0.5;
  }

  // Require a minimum digit presence to distinguish from natural language.
  if (digitRatio < 0.05) return false;

  // Tokens with 3+ underscore/hyphen separators usually look like code
  // identifiers, not secrets.
  const separators = (token.match(/[_-]/g) ?? []).length;
  if (separators >= 3 && digitRatio < 0.2) return false;

  return distinct >= 8 || ratio >= 0.4;
}

export function redactText(input: string): string {
  let out = input;

  // 1) Windows paths: `C:\Users\alice\creds.txt`
  out = out.replace(/\b[A-Za-z]:\\(?:[\w\-.]+\\?)+/g, '<PATH>');

  // 2) Unix absolute paths (>= 2 segments with explicit / separators)
  out = out.replace(/\/[\w\-.]+(?:\/[\w\-.]+)+/g, '<PATH>');

  // 3) AWS access keys: `AKIA` + 16 uppercase alnum
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<TOKEN>');

  // 4) Env-var assignments — only allowlisted prefixes/suffixes, only at
  //    a recognized boundary. Boundary = start-of-string, whitespace, or
  //    one of `\`'":,;` (matched as a non-capturing lookbehind via group 1).
  out = out.replace(
    /(^|[\s`'":,;])([A-Z][A-Z0-9_]{2,})=(\S+)/g,
    (_match, lead: string, name: string, _value: string) => {
      if (!isAllowlistedEnvName(name)) return _match;
      return `${lead}<ENV>=<TOKEN>`;
    },
  );

  // 5) Generic long tokens (>= 24 chars). Use a callback to apply the
  //    entropy heuristic — pure regex replacement can't decide per-match.
  out = out.replace(/\b[A-Za-z0-9_-]{24,}\b/g, (m: string) => {
    if (m === '<ENV>' || m === '<TOKEN>' || m === '<PATH>') return m;
    return looksHighEntropy(m) ? '<TOKEN>' : m;
  });

  return out;
}

/**
 * Planning-stream: scrub a single narration line before it is buffered/broadcast.
 * Mirrors the `SHARED_BRAINSTORM_NO_REDACT` opt-out used by {@link redactQuestion}
 * so the kill-switch behaves identically for both surfaces.
 */
export function redactStreamLine(text: string): string {
  return REDACTION_DISABLED ? text : redactText(text);
}

export function redactQuestion(q: AskGroupInput): AskGroupInput {
  if (REDACTION_DISABLED) {
    const out: AskGroupInput = { question: q.question };
    if (q.options !== undefined) out.options = q.options;
    if (q.recommendation !== undefined) out.recommendation = q.recommendation;
    return out;
  }
  const out: AskGroupInput = {
    question: redactText(q.question),
  };
  if (q.options !== undefined) {
    out.options = q.options.map((o) => {
      const opt: { label: string; description?: string } = {
        label: redactText(o.label),
      };
      if (o.description !== undefined) {
        opt.description = redactText(o.description);
      }
      return opt;
    });
  }
  if (q.recommendation !== undefined) {
    out.recommendation = redactText(q.recommendation);
  }
  return out;
}
