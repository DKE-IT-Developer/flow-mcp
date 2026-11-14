// Motion check on every finished clip (DKE fork, 14 Nov 2026). Video models fail mid-move: a jump to the end frame
// (Omni at ~4.9 s), a morph, a limb that pops in. Those show up as ONE frame that differs from its neighbours far more
// than the frames around it. Ported from the sinema-natural plugin's cek_sambung.py: grey 90x160 frames, mean absolute
// difference per frame, compared with the median of the 4 frames on each side; >= 6x is a jump.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const W = 90, H = 160, RATIO = 6;

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
};

// Pure part, testable: per-frame differences -> seconds where a jump happens.
export function findJumps(diffs: number[], fps: number): { t: number; ratio: number }[] {
  const med = Math.max(median(diffs), 1e-6);
  const out: { t: number; ratio: number }[] = [];
  diffs.forEach((d, i) => {
    const near = median([...diffs.slice(Math.max(0, i - 4), i), ...diffs.slice(i + 1, i + 5)]);
    const ratio = d / Math.max(near, 0.5 * med);
    if (ratio >= RATIO) out.push({ t: Number(((i + 1) / fps).toFixed(2)), ratio: Number(ratio.toFixed(1)) });
  });
  return out;
}

// One line for the job note: where it jumps and which stretch is clean to use.
export async function motionCheck(video: string): Promise<string> {
  const fps = 24;
  const { stdout } = await run(FFMPEG, ["-v", "error", "-i", video, "-vf", `fps=${fps},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], {
    encoding: "buffer",
    maxBuffer: 1 << 28,
  });
  const n = Math.floor(stdout.length / (W * H));
  const diffs: number[] = [];
  for (let f = 1; f < n; f++) {
    let sum = 0;
    for (let p = 0; p < W * H; p++) sum += Math.abs(stdout[f * W * H + p] - stdout[(f - 1) * W * H + p]);
    diffs.push(sum / (W * H));
  }
  const jumps = findJumps(diffs, fps);
  const len = n / fps;
  if (!jumps.length) return `motion check: no jump (${len.toFixed(1)} s) - still look at it at 8 fps for morphs and hands`;
  // The longest clean stretch between jumps (with 0.1 s margin) is the part worth cutting to.
  const edges = [0, ...jumps.map((j) => j.t), len];
  let best = [0, 0];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = i ? edges[i] + 0.1 : 0, b = i + 2 < edges.length ? edges[i + 1] - 0.1 : edges[i + 1];
    if (b - a > best[1] - best[0]) best = [a, b];
  }
  return `motion check: JUMP at ${jumps.map((j) => `${j.t} s (${j.ratio}x)`).join(", ")} - longest clean range ${best[0].toFixed(1)}-${best[1].toFixed(1)} s`;
}

// ponytail: self-check without a framework — `node dist/motion.js --cek`
if (process.argv[1]?.endsWith("motion.js") && process.argv.includes("--cek")) {
  const smooth = Array.from({ length: 190 }, (_, i) => 2 + Math.sin(i / 7));
  if (findJumps(smooth, 24).length) throw new Error("smooth motion must not count as a jump");
  const jumped = [...smooth];
  jumped[117] = 30;
  const j = findJumps(jumped, 24);
  if (j.length !== 1 || j[0].t !== 4.92) throw new Error(`expected one jump at 4.92 s, got ${JSON.stringify(j)}`);
  console.log("motion ok");
}
