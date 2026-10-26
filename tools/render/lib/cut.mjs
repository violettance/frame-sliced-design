// Paper edit -> cleaned voice track + frame-accurate base footage.
// Each piece gets a short lead-in (keeps the breath); its end is extended until the
// sound has decayed so word endings are never clipped. hardOut cuts exactly at 'out'.
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { run, decodeAudio } from './util.mjs';

const SR = 16000, FPS = 30;

function levelDb(x, t) {
  const a = Math.floor(t * SR), b = Math.min(x.length, Math.floor((t + 0.02) * SR));
  if (b <= a || a < 0) return -99;
  let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / (b - a) + 1e-18);
}

export async function cut(edit, { editDir, outDir, width = 1080, height = 1920 }) {
  outDir = path.resolve(outDir);
  const tmp = path.join(outDir, 'tmp'); mkdirSync(tmp, { recursive: true });
  const srcs = Object.fromEntries(Object.entries(edit.sources).map(([k, v]) => [k, path.resolve(editDir, v)]));
  const mono = {};
  for (const [k, v] of Object.entries(srcs)) mono[k] = (await decodeAudio(v, { sr: SR, channels: 1 }))[0];

  const plan = edit.pieces.map((p, i) => {
    const x = mono[p.src]; let start = p.in - 0.15;
    while (start > p.in - 0.32 && start > 0 && levelDb(x, start - 0.02) > -50) start -= 0.02;
    start = Math.max(0, start);
    let end = p.out;
    if (!p.hardOut) { while (end < p.out + 0.4 && levelDb(x, end) > -50) end += 0.02; end += 0.1; }
    if (i === edit.pieces.length - 1) end = Math.max(end, p.out + 0.6);
    return { src: p.src, start, end, hard: !!p.hardOut };
  });
  const frames = [0]; let t = 0;
  for (const p of plan) { t += p.end - p.start; frames.push(Math.round(t * FPS)); }

  // audio pieces
  const parts = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i], d = (frames[i + 1] - frames[i]) / FPS, fo = p.hard ? 0.03 : 0.05, fn = path.join(tmp, `a${i}.wav`);
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', p.start.toFixed(3), '-t', d.toFixed(3), '-i', srcs[p.src], '-vn',
      '-af', `afade=t=in:d=0.015,afade=t=out:st=${(d - fo).toFixed(3)}:d=${fo}`, '-ar', '48000', '-ac', '1', fn]);
    parts.push(fn);
  }
  const alist = path.join(tmp, 'a.txt'); writeFileSync(alist, parts.map(f => `file '${f}'\n`).join(''));
  const raw = path.join(tmp, 'raw.wav');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', alist, raw]);
  const pre = 'highpass=f=70,afftdn=nr=8:nf=-60:tn=1,acompressor=threshold=-22dB:ratio=2.5:attack=10:release=180:makeup=2';
  const { stderr } = await run('ffmpeg', ['-y', '-i', raw, '-af', pre + ',loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json', '-f', 'null', '-']);
  const j = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
  const ln = `loudnorm=I=-16:TP=-1.5:LRA=9:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  await run('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', `${pre},${ln}`, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', path.join(outDir, 'voice.m4a')]);

  // video pieces (frame accurate)
  const vparts = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i], fn = path.join(tmp, `v${i}.mp4`);
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', p.start.toFixed(3), '-i', srcs[p.src], '-frames:v', String(frames[i + 1] - frames[i]), '-an',
      '-vf', `scale=${width}:${height}:flags=lanczos,fps=${FPS}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', fn]);
    vparts.push(fn);
  }
  const vlist = path.join(tmp, 'v.txt'); writeFileSync(vlist, vparts.map(f => `file '${f}'\n`).join(''));
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', vlist, '-c', 'copy', path.join(outDir, 'base.mp4')]);

  const info = plan.map((p, i) => ({ n: i + 1, src: p.src, srcIn: +p.start.toFixed(3), srcOut: +p.end.toFixed(3), editStart: +(frames[i] / FPS).toFixed(3) }));
  writeFileSync(path.join(outDir, 'pieces.json'), JSON.stringify(info, null, 1));
  return { duration: frames[frames.length - 1] / FPS, segments: [...info.map(x => x.editStart), +(frames[frames.length - 1] / FPS).toFixed(3)] };
}
