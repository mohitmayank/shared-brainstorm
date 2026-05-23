/**
 * assemble.mjs — build the promo from high-res frame sequences + narration.
 * Per-scene slideshow clips (3840→1920 lanczos), crossfaded together, with
 * lower-third captions and narration aligned to post-xfade scene offsets.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve('.');
const F = `${DIR}/frames`;
const C = `${DIR}/clips`;
const A = `${DIR}/audio`;
mkdirSync(C, { recursive: true });
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const BG = '0x0d1117';
const XF = 0.6; // crossfade duration

const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const probe = (f) =>
  parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString().trim());

const glob = (re) => readdirSync(F).filter((f) => re.test(f)).sort().map((f) => `${F}/${f}`);

// ---- scene definitions: ordered frame list + per-frame durations ----
// Narration durations (s) per scene; +0.6 tail folded into hold of last frame.
const NARR = { 1: 8.78, 2: 11.1, 3: 10.21, 4: 13.04, 5: 10.34, 6: 8.36, 7: 5.56 };
const TAIL = 0.6;
const D = Object.fromEntries(Object.entries(NARR).map(([k, v]) => [k, +(v + TAIL).toFixed(2)]));

function durs(frames, perFrame, total) {
  const n = frames.length;
  const head = perFrame * (n - 1);
  const last = Math.max(perFrame, +(total - head).toFixed(2));
  return frames.map((_, i) => (i < n - 1 ? perFrame : last));
}

const CAP = {
  1: 'shared-brainstorm',
  2: '1 · Ask your agent — link auto-copied',
  3: '2 · Approve joiners — no codes, no accounts',
  4: '3 · The team weighs in, live',
  5: '4 · Add your answer · pick the final',
  6: '5 · The agent plans with team input',
  7: '',
};

function capFilter(text) {
  if (!text) return '';
  const esc = text.replace(/:/g, '\\:');
  return `,drawtext=fontfile=${FONT}:text='${esc}':fontcolor=white:fontsize=38:box=1:boxcolor=0x000000B0:boxborderw=24:x=90:y=h-140`;
}

// Build one scene clip from frames+durations
function buildScene(n, frames, frameDurs) {
  const total = frameDurs.reduce((a, b) => a + b, 0);
  // concat demuxer list (image durations)
  let list = '';
  frames.forEach((f, i) => {
    list += `file '${f}'\nduration ${frameDurs[i]}\n`;
  });
  list += `file '${frames[frames.length - 1]}'\n`; // demuxer needs last repeated
  const lf = `${C}/list-s${n}.txt`;
  writeFileSync(lf, list);
  const vf = `scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=${BG},fps=30${capFilter(CAP[n])},format=yuv420p`;
  ff(['-f', 'concat', '-safe', '0', '-i', lf, '-vf', vf, '-t', total.toFixed(2),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', `${C}/scene${n}.mp4`]);
  console.log(`scene${n}: ${frames.length} frames, ${total.toFixed(2)}s`);
  return total;
}

// ---- assemble scene clips ----
const dur = {};
dur[1] = buildScene(1, glob(/^s1-/), durs(glob(/^s1-/), 0.4, D[1]));
dur[2] = buildScene(2, glob(/^s2-/), durs(glob(/^s2-/), 0.4, D[2]));
dur[3] = (() => { const fr = glob(/^live3-/); return buildScene(3, fr, durs(fr, 1.6, D[3])); })();
// scene 4 = terminal post (s4-*) quick + planner (live4-*) steps
const s4t = glob(/^s4-/), s4p = glob(/^live4-/);
const fr4 = [...s4t, ...s4p];
const d4 = [...s4t.map(() => 0.35), ...(() => { const rem = +(D[4] - 0.35 * s4t.length).toFixed(2); return durs(s4p, 1.6, rem); })()];
dur[4] = buildScene(4, fr4, d4);
dur[5] = (() => { const fr = glob(/^live5-/); return buildScene(5, fr, durs(fr, 1.6, D[5])); })();
dur[6] = buildScene(6, glob(/^s6-/), durs(glob(/^s6-/), 0.4, D[6]));
dur[7] = buildScene(7, glob(/^s7-/), [D[7]]);

// ---- crossfade video chain ----
const order = [1, 2, 3, 4, 5, 6, 7];
const inputs = order.flatMap((n) => ['-i', `${C}/scene${n}.mp4`]);
let filt = '';
let prev = '0:v';
let offset = 0;
const starts = { 1: 0 };
for (let i = 1; i < order.length; i++) {
  offset += dur[order[i - 1]] - XF;
  starts[order[i]] = +offset.toFixed(3);
  const out = i === order.length - 1 ? 'vout' : `v${i}`;
  filt += `[${prev}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[${out}];`;
  prev = out;
}
// 2s static holds (clone of the VISIBLE first/last frame) bracket the reel,
// applied to [vout] BEFORE the fades so the open/close fade through the holds
// rather than leaving a black gap. PAD seconds of silent lead-in/out-tro.
const PAD = 2;
const totalV = (offset + dur[order[order.length - 1]]).toFixed(3);
const paddedTotal = (+totalV + 2 * PAD).toFixed(3);
filt += `[vout]tpad=start_duration=${PAD}:start_mode=clone:stop_duration=${PAD}:stop_mode=clone,`
  + `fade=t=in:st=0:d=0.5,fade=t=out:st=${(+paddedTotal - 0.6).toFixed(3)}:d=0.6[vfinal]`;
ff([...inputs, '-filter_complex', filt, '-map', '[vfinal]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', `${C}/video.mp4`]);
console.log('video built', paddedTotal, 's (', PAD, 's holds); scene starts', starts);

// ---- audio: narration aligned to scene starts, amix ----
const aInputs = order.flatMap((n) => ['-i', `${A}/scene-0${n}.mp3`]);
// narration is delayed by the same PAD so it begins after the start hold;
// apad lets the final -shortest mux trim audio to the (longer) padded video.
let aFilt = order.map((n, i) => {
  const ms = Math.round((starts[n] + PAD) * 1000);
  return `[${i}:a]adelay=${ms}|${ms}[a${i}]`;
}).join(';') + ';';
aFilt += order.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${order.length}:normalize=0:dropout_transition=0,apad[aout]`;
ff([...aInputs, '-filter_complex', aFilt, '-map', '[aout]', '-t', paddedTotal, '-c:a', 'aac', '-b:a', '192k', `${C}/narration.m4a`]);

// ---- mux ----
ff(['-i', `${C}/video.mp4`, '-i', `${C}/narration.m4a`, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', `${DIR}/shared-brainstorm-promo.mp4`]);
console.log('DONE -> shared-brainstorm-promo.mp4', probe(`${DIR}/shared-brainstorm-promo.mp4`).toFixed(2), 's');
