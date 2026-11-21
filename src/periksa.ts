// Cek otomatis setelah unduh (tahap 1): wajah, ucapan, suara lewat skrip plugin sinema-natural (SINEMA_SCRIPTS).
// Tidak pernah melempar ke pemanggil: skrip hilang / timeout / keluaran aneh = catatan "dilewati: <alasan>", job tetap done.
// Self-check: `node dist/periksa.js --cek`
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { loadProduction, mergeQa, readQa, resolvePrivate, type ClipQa, type Production } from "./produksi.js";

type Shot = Production["shots"][number];
const FACE_MIN = 0.8;
const timeoutMs = () => Number(process.env.FLOW_MCP_CHECK_TIMEOUT_MS) || 180000;

class Skip extends Error {}

function scriptsDir(): string {
  const d = process.env.SINEMA_SCRIPTS?.trim();
  if (!d) throw new Skip("SINEMA_SCRIPTS belum diatur");
  return d;
}

/** Jalankan satu skrip (berurutan, nice -n 10) dan kembalikan JSON dari BARIS TERAKHIR stdout. */
async function runScript(name: string, args: string[]): Promise<unknown> {
  const script = join(scriptsDir(), name);
  if (!existsSync(script)) throw new Skip(`${name} tidak terpasang`);
  const out = await new Promise<string>((resolve, reject) => {
    execFile("nice", ["-n", "10", "uv", "run", script, ...args], { timeout: timeoutMs(), maxBuffer: 1 << 24, encoding: "utf8" }, (err, stdout, stderr) => {
      // cek_ucapan keluar non-nol bila MERAH; JSON di stdout tetap valid -> pakai bila ada.
      if (err && (err as { killed?: boolean }).killed) return reject(new Skip("batas waktu"));
      if (err && !stdout?.trim()) return reject(new Skip(`${name} gagal: ${String(stderr || err.message).trim().split("\n").pop()}`));
      resolve(stdout);
    });
  });
  const last = out.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  try { return JSON.parse(last); } catch { throw new Skip(`${name}: keluaran bukan JSON`); }
}

/** Skor wajah (median kemiripan) gambar/klip terhadap referensi; null bila wajah tak terdeteksi. */
export async function faceScore(image: string, refs: string[]): Promise<number | null> {
  const r = (await runScript("cek_konsisten.py", ["--json", "--min-mirip", String(FACE_MIN), "--ref", ...refs, image])) as { median?: number | null; face?: number | null };
  const v = r.median ?? r.face ?? null;
  return typeof v === "number" ? v : null;
}

const reason = (e: unknown) => (e instanceof Skip ? e.message : `error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);

export async function postChecks(file: string, projectDir: string, shot: Shot): Promise<string[]> {
  const notes: string[] = [];
  // Kunci tak terisi dibuat eksplisit undefined: mergeQa menggabung per kolom, jadi nilai lama dari cek sebelumnya terhapus.
  const qa: ClipQa = { face_median: undefined, speech: undefined, voice: undefined };
  const skipped: string[] = [];
  const skip = (what: string, e: unknown) => {
    const r = reason(e);
    skipped.push(`${what}: ${r}`);
    notes.push(`dilewati: ${what} (${r})`);
  };
  let prod: Production | undefined;
  try { prod = loadProduction(projectDir); } catch { /* produksi.json rusak: cek tak bisa menentukan pemeran */ }
  const cast = shot.cast.map((n) => prod?.cast[n]).filter((c): c is NonNullable<typeof c> => !!c);

  // wajah: face_refs[expression] tiap pemeran di shot
  try {
    const refs = cast.map((c) => c.face_refs[shot.expression ?? ""]).filter((r): r is string => !!r).map((r) => resolvePrivate(projectDir, r));
    if (!refs.length) throw new Skip("tanpa referensi wajah");
    const v = await faceScore(file, refs);
    if (v === null) throw new Skip("wajah tidak terdeteksi");
    qa.face_median = v;
    notes.push(v < FACE_MIN ? `wajah median ${v.toFixed(2)} < ${FACE_MIN.toFixed(2)} (review)` : `wajah median ${v.toFixed(2)}`);
  } catch (e) { skip("wajah", e); }

  // ucapan: hanya bila ada beat ber-says
  const lines = shot.beats.map((b) => b.says?.trim()).filter((x): x is string => !!x);
  if (lines.length) {
    try {
      const r = (await runScript("cek_ucapan.py", [file, lines.join(" "), "--json"])) as { pass?: boolean; words_ok?: boolean; rise?: number | null; heard?: string };
      const line = r.pass ? "ucapan LULUS" : `ucapan MERAH: ${r.words_ok === false ? "kata tidak cocok" : "nada tanya tidak naik"}${r.rise != null ? ` (naik ${r.rise}x)` : ""}, terdengar "${r.heard ?? ""}"`;
      qa.speech = line;
      notes.push(line);
    } catch (e) { skip("ucapan", e); }
  }

  // suara: hanya bila ada voice_ref (informasi)
  const withVoice = cast.find((c) => c.voice_ref);
  if (withVoice) {
    try {
      const r = (await runScript("cek_suara.py", [resolvePrivate(projectDir, withVoice.voice_ref!), file, "--json"])) as { similarity?: number }[];
      const v = r?.[0]?.similarity;
      if (typeof v !== "number") throw new Skip("tanpa skor");
      qa.voice = v;
      notes.push(`suara ${v.toFixed(2)} (informasi)`);
    } catch (e) { skip("suara", e); }
  }

  qa.skipped = skipped.length ? skipped : undefined;
  try { mergeQa(projectDir, shot.id, { clips: { [basename(file)]: qa } }); } catch (e) { notes.push(`dilewati: qa.json tidak ditulis (${reason(e)})`); }
  return notes;
}

// ponytail: self-check - `node dist/periksa.js --cek`
if (process.argv[1]?.endsWith("periksa.js") && process.argv.includes("--cek")) {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(`GAGAL: ${m}`); };
  const root = mkdtempSync(join(tmpdir(), "periksa-cek-"));
  const proj = join(root, "2026-01-01-kopi-pagi");
  const scripts = join(root, "skrip");
  mkdirSync(proj); mkdirSync(scripts);
  writeFileSync(join(proj, "ref.jpg"), "x"); writeFileSync(join(proj, "voice.wav"), "x"); writeFileSync(join(proj, "S01.mp4"), "x");
  const prod = {
    version: 1, title: "Kopi pagi", aspect_ratio: "9:16", stage: "qa", camera: "handheld",
    cast: { raka: { identity: "pria muda", face_refs: { netral: "ref.jpg" }, voice_ref: "voice.wav" } },
    worlds: { dapur: { location: "dapur", light: "pagi" } },
    shots: [
      { id: "S01", world: "dapur", cast: ["raka"], angle: "eye-level", scale: "MS", expression: "netral", beats: [{ at: [0, 4], action: "menuang kopi", says: "Kopi pagi" }, { at: [4, 8], action: "tersenyum", says: "enak sekali" }] },
      { id: "S02", world: "dapur", cast: [], angle: "eye-level", scale: "MS", beats: [] },
    ],
  };
  writeFileSync(join(proj, "produksi.json"), JSON.stringify(prod));
  const shots = loadProduction(proj)!.shots;
  const py = (name: string, body: string) => writeFileSync(join(scripts, name), body);
  const fixed = (name: string, json: string) => py(name, `import sys\nprint("log noise")\nprint(${JSON.stringify(json)})\n`.replace(/\\n/g, "\n"));
  const saved = { s: process.env.SINEMA_SCRIPTS, t: process.env.FLOW_MCP_CHECK_TIMEOUT_MS };
  try {
    // 1. tanpa env
    delete process.env.SINEMA_SCRIPTS;
    let n = await postChecks(join(proj, "S01.mp4"), proj, shots[0]);
    assert(n.some((l) => l.includes("dilewati: wajah (SINEMA_SCRIPTS belum diatur)")), `tanpa env: ${n}`);
    // 2. skrip tetap
    process.env.SINEMA_SCRIPTS = scripts;
    fixed("cek_konsisten.py", '{"face": 0.78, "median": 0.78, "merah": true}');
    fixed("cek_ucapan.py", '{"words_ok": true, "rise": null, "pass": true, "heard": "kopi pagi enak sekali"}');
    fixed("cek_suara.py", '[{"file": "S01.mp4", "similarity": 0.71}]');
    n = await postChecks(join(proj, "S01.mp4"), proj, shots[0]);
    assert(n.includes("wajah median 0.78 < 0.80 (review)"), `wajah: ${n}`);
    assert(n.includes("ucapan LULUS"), `ucapan: ${n}`);
    assert(n.includes("suara 0.71 (informasi)"), `suara: ${n}`);
    const clip = readQa(proj).S01.clips!["S01.mp4"];
    assert(clip.face_median === 0.78 && clip.voice === 0.71 && clip.speech === "ucapan LULUS" && !clip.skipped, "qa.json tergabung");
    // 3. ucapan merah
    fixed("cek_ucapan.py", '{"words_ok": false, "rise": null, "pass": false, "heard": "kopi"}');
    n = await postChecks(join(proj, "S01.mp4"), proj, shots[0]);
    assert(n.some((l) => l.startsWith("ucapan MERAH")), `merah: ${n}`);
    // 4. timeout
    process.env.FLOW_MCP_CHECK_TIMEOUT_MS = "1000";
    py("cek_konsisten.py", "import time\ntime.sleep(5)\n".replace(/\\n/g, "\n"));
    n = await postChecks(join(proj, "S01.mp4"), proj, shots[0]);
    assert(n.includes("dilewati: wajah (batas waktu)"), `timeout: ${n}`);
    assert(readQa(proj).S01.clips!["S01.mp4"].skipped?.some((x) => x.includes("batas waktu")), "skipped dicatat");
    // 5. skrip hilang + keluaran bukan JSON + skrip crash
    rmSync(join(scripts, "cek_suara.py"));
    py("cek_ucapan.py", "print('bukan json')\n".replace(/\\n/g, "\n"));
    py("cek_konsisten.py", "raise SystemExit(3)\n");
    n = await postChecks(join(proj, "S01.mp4"), proj, shots[0]);
    assert(n.includes("dilewati: suara (cek_suara.py tidak terpasang)"), `hilang: ${n}`);
    assert(n.includes("dilewati: ucapan (cek_ucapan.py: keluaran bukan JSON)"), `bukan json: ${n}`);
    assert(n.some((l) => l.startsWith("dilewati: wajah")), `crash: ${n}`);
    // 6. shot tanpa pemeran/dialog: hanya wajah dilewati
    n = await postChecks(join(proj, "S01.mp4"), proj, shots[1]);
    assert(n.length === 1 && n[0].includes("tanpa referensi wajah"), `S02: ${n}`);
    console.log("periksa ok");
  } finally {
    if (saved.s === undefined) delete process.env.SINEMA_SCRIPTS; else process.env.SINEMA_SCRIPTS = saved.s;
    if (saved.t === undefined) delete process.env.FLOW_MCP_CHECK_TIMEOUT_MS; else process.env.FLOW_MCP_CHECK_TIMEOUT_MS = saved.t;
  }
}
