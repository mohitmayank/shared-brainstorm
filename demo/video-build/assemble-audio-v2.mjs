/**
 * assemble-audio-v2.mjs — swap ONLY the narration on the already-built reel.
 * Reuses clips/video.mp4 (pixel-identical video) and muxes a fresh narration
 * track. Each clip is aligned to the same scene-start offset (+2s lead-in) as
 * v1; any clip longer than its scene window is atempo-fitted so neighbouring
 * narrations never overlap. THROWAWAY build helper.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const DIR = resolve('.');
const C = `${DIR}/clips`;
const A = process.env.AUDIO_DIR || `${DIR}/audio-v2`;
const OUT = process.env.OUT || `${DIR}/shared-brainstorm-promo-enthusiastic.mp4`;
const PAD = 2; // start lead-in (matches assemble.mjs)

const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const probe = (f) =>
  parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString().trim());

const order = [1, 2, 3, 4, 5, 6, 7];
// scene-start offsets baked into the existing video.mp4 (pre-pad timeline)
const starts = { 1: 0, 2: 8.78, 3: 19.88, 4: 30.09, 5: 43.13, 6: 53.47, 7: 61.83 };
// narration window per scene = gap to next scene's narration (last = to reel end)
const videoLen = probe(`${C}/video.mp4`);
const room = {};
order.forEach((n, i) => {
  const next = i < order.length - 1 ? starts[order[i + 1]] : videoLen - 2 * PAD;
  room[n] = +(next - starts[n]).toFixed(3);
});

const aInputs = order.flatMap((n) => ['-i', `${A}/scene-0${n}.mp3`]);
const parts = [];
order.forEach((n, i) => {
  const len = probe(`${A}/scene-0${n}.mp3`);
  const tempo = Math.max(1.0, +(len / room[n]).toFixed(4));
  const ms = Math.round((starts[n] + PAD) * 1000);
  // atempo (no-op at 1.0) then delay to the scene start
  parts.push(`[${i}:a]atempo=${tempo},adelay=${ms}|${ms}[a${i}]`);
  console.log(`scene${n}: ${len.toFixed(2)}s -> window ${room[n].toFixed(2)}s, tempo ${tempo}`);
});
let aFilt = parts.join(';') + ';';
// apad=whole_dur pads by sample count to the exact reel length (PTS-independent;
// adelay/amix leave a broken container PTS, so a plain -t cut would zero it out).
// PCM WAV intermediate avoids the m4a edit-list quirk entirely.
aFilt += order.map((_, i) => `[a${i}]`).join('')
  + `amix=inputs=${order.length}:normalize=0:dropout_transition=0,apad=whole_dur=${videoLen.toFixed(3)}[aout]`;

ff([...aInputs, '-filter_complex', aFilt, '-map', '[aout]', '-ar', '44100', '-ac', '1', `${C}/narration-v2.wav`]);

// mux fresh audio onto the UNTOUCHED video
ff(['-i', `${C}/video.mp4`, '-i', `${C}/narration-v2.wav`, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', OUT]);
console.log('DONE ->', OUT, probe(OUT).toFixed(2), 's');
