#!/usr/bin/env node
process.env.SB_FORCE_MAIN = '1';
import('../dist/cli.js').catch((e) => {
  console.error(e);
  process.exit(1);
});
