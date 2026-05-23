/**
 * capture.mjs — high-res scene capture for the promo (Playwright, dsf=2).
 * Terminal scenes via the local mock; live scenes drive the real LAN session.
 * Writes 3840x2160 PNG frames to demo/video-build/frames/.
 * THROWAWAY.
 */
import { chromium } from 'playwright';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const state = JSON.parse(readFileSync('/tmp/sb-state.json', 'utf8'));
const BASE = state.public_url;
const COORD_URL = state.coordinator_url;
const MOCK = 'http://127.0.0.1:8911/terminal.html';
const CMD = '/tmp/sb-cmd.jsonl';
const OUT = 'demo/video-build/frames';
mkdirSync(OUT, { recursive: true });

const VP = { width: 1920, height: 1080 };
const DSF = 2;
const ZOOM = '1.3'; // live-UI zoom so content fills the frame

const browser = await chromium.launch();
const log = (...a) => console.log('[capture]', ...a);

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  log('shot', name);
}

// dark theme persists in localStorage per context; reload to apply on first set
async function setDark(page) {
  await page.evaluate(() => localStorage.setItem('sb.theme', 'dark'));
  await page.reload();
  await page.waitForTimeout(500);
}
// zoom via injected stylesheet (reliable; must re-apply after each navigation)
async function applyZoom(page) {
  await page.addStyleTag({ content: `html{zoom:${ZOOM} !important}` });
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// TERMINAL scenes — stepped still-frames from the mock
// ---------------------------------------------------------------------------
async function captureTerminal() {
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const page = await ctx.newPage();
  const scenes = { 1: null, 2: null, 4: null, 6: null };
  for (const s of Object.keys(scenes)) {
    await page.goto(`${MOCK}?scene=${s}&upto=0`);
    await page.waitForTimeout(150);
    const n = await page.evaluate((sc) => window.__opCount(sc), s);
    let frame = 1;
    for (let k = 2; k <= n; k++) {
      await page.evaluate(([sc, kk]) => window.__render(sc, kk), [s, k]);
      await page.waitForTimeout(60);
      await shot(page, `s${s}-${String(frame).padStart(2, '0')}`);
      frame++;
    }
  }
  // Scene 7 — outro card (single frame)
  await page.goto(`${MOCK}?scene=7`);
  await page.waitForTimeout(300);
  await shot(page, 's7-01');
  await ctx.close();
}

// ---------------------------------------------------------------------------
// LIVE scenes
// ---------------------------------------------------------------------------
async function captureLive() {
  // request-only contexts for injected teammates
  const samCtx = await browser.newContext();
  const jordanCtx = await browser.newContext();
  await samCtx.request.post(`${BASE}/api/join`, { data: { display_name: 'Sam' } });
  await jordanCtx.request.post(`${BASE}/api/join`, { data: { display_name: 'Jordan' } });

  // coordinator context + page
  const coordCtx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const coord = await coordCtx.newPage();
  await coord.goto(COORD_URL);
  await setDark(coord);
  await applyZoom(coord);

  // ---- SCENE 3: approve joiners ----
  await shot(coord, 'live3-01'); // both pending
  await coord.locator('button:has-text("Approve")').first().click();
  await coord.waitForTimeout(500);
  await shot(coord, 'live3-02'); // Sam approved
  await coord.locator('button:has-text("Approve")').first().click();
  await coord.waitForTimeout(500);
  await shot(coord, 'live3-03'); // both approved

  // ---- post the question via driver queue ----
  appendFileSync(
    CMD,
    JSON.stringify({
      cmd: 'ask',
      question: 'Sessions in Postgres or Redis?',
      options: [{ label: 'Postgres' }, { label: 'Redis' }],
      recommendation: 'Redis — built-in TTL, fast reads',
    }) + '\n',
  );
  // wait for the question to land
  let qid = null;
  for (let i = 0; i < 30 && !qid; i++) {
    await sleep(400);
    const r = await samCtx.request.get(`${BASE}/api/session`);
    const d = await r.json();
    if (d.questions && d.questions[0]) qid = d.questions[0].id;
  }
  log('question id', qid);

  // ---- inject Sam + Jordan suggestions & comment ----
  await samCtx.request.post(`${BASE}/api/suggestion`, {
    data: { question_id: qid, value: 'Redis', rationale: 'We already run it for caching — TTL is free and reads are sub-ms.' },
  });
  await jordanCtx.request.post(`${BASE}/api/suggestion`, {
    data: { question_id: qid, value: 'Postgres', rationale: 'One datastore to operate, and sessions stay transactional with the user rows.' },
  });
  await jordanCtx.request.post(`${BASE}/api/comment`, {
    data: { question_id: qid, text: 'Redis means one more thing to keep alive in prod, worth weighing.' },
  });

  // ---- SCENE 4: planner (Alex) ----
  const alexCtx = await browser.newContext({ viewport: VP, deviceScaleFactor: DSF });
  const alex = await alexCtx.newPage();
  await alex.goto(BASE);
  await alex.evaluate(() => localStorage.setItem('sb.theme', 'dark'));
  await alex.reload();
  await alex.locator('input').first().fill('Alex');
  await alex.locator('button:has-text("Continue")').click();
  await alex.waitForTimeout(600);
  // approve Alex via coordinator request ctx
  const sess = await (await samCtx.request.get(`${BASE}/api/session`)).json();
  const alexId = sess.participants.find((p) => p.display_name === 'Alex')?.id;
  await coordCtx.request.post(`${BASE}/api/coordinator/approve`, { data: { participant_id: alexId } });
  await alex.waitForTimeout(800);
  await applyZoom(alex);
  await shot(alex, 'live4-01'); // question card with suggestions
  await alex.locator('input[type="radio"][value="Redis"]').click();
  await alex.waitForTimeout(300);
  await shot(alex, 'live4-02');
  await alex.locator('input[placeholder*="Rationale"], textarea[placeholder*="Rationale"]').fill('Sessions are short-lived — Redis TTL fits perfectly.');
  await alex.waitForTimeout(200);
  await shot(alex, 'live4-03');
  // Sam adds a live comment
  await samCtx.request.post(`${BASE}/api/comment`, {
    data: { question_id: qid, text: "Fair — but the cache is already in our infra, so it's not a new dependency." },
  });
  await alex.waitForTimeout(700);
  await shot(alex, 'live4-04'); // comment streamed in
  await alex.locator('button:has-text("Submit")').click();
  await alex.waitForTimeout(700);
  await shot(alex, 'live4-05'); // Alex pick recorded

  // ---- SCENE 5: coordinator picks ----
  await coord.goto(COORD_URL);
  await coord.waitForTimeout(700);
  await applyZoom(coord);
  await coord.locator('text=Suggestions').first().scrollIntoViewIfNeeded();
  await coord.waitForTimeout(300);
  await shot(coord, 'live5-01'); // decision area
  // add own answer (planner): the Redis radio (value="Redis" is unique to the
  // "Add your answer" section; suggestion radios use the suggestion id as value)
  await coord.locator('input[type="radio"][value="Redis"]').click();
  await coord.waitForTimeout(300);
  await shot(coord, 'live5-02');
  await coord.locator('button:has-text("Add to suggestions")').click();
  await coord.waitForTimeout(800);
  await coord.locator('text=Suggestions').first().scrollIntoViewIfNeeded();
  await shot(coord, 'live5-03'); // Coordinator: Redis joined pool
  // pick the coordinator's own suggestion, then record
  await coord.locator('label:has-text("Coordinator"), :text("Coordinator: Redis")').first().click().catch(() => {});
  // robust: click the radio in the suggestion row containing "Coordinator"
  await coord.evaluate(() => {
    const rows = [...document.querySelectorAll('label,li,div')].filter((e) => /Coordinator/.test(e.textContent || ''));
    for (const r of rows) { const radio = r.querySelector('input[type=radio]'); if (radio) { radio.click(); return; } }
  });
  await coord.waitForTimeout(400);
  await shot(coord, 'live5-04'); // selected
  await coord.locator('button:has-text("Record this")').click();
  await coord.waitForTimeout(1000);
  await coord.evaluate(() => window.scrollTo(0, 0));
  await coord.waitForTimeout(400);
  await shot(coord, 'live5-05'); // decided

  await browser.close();
}

const mode = process.argv[2] || 'all';
if (mode === 'terminal' || mode === 'all') await captureTerminal();
if (mode === 'live' || mode === 'all') await captureLive();
await browser.close().catch(() => {});
log('DONE');
