// Cek otomatis setelah unduh (tahap 1): wajah, ucapan, suara lewat skrip plugin sinema-natural (SINEMA_SCRIPTS).
// Tidak pernah melempar ke pemanggil: skrip hilang / timeout / keluaran aneh = catatan "dilewati: <alasan>", job tetap done.
// Self-check: `node dist/periksa.js --cek`
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { loadProduction, mergeQa, readQa, registerFaceScores, resolvePrivate, type ClipQa, type Production } from "./produksi.js";

type Shot = Production["shots"][number];
const FACE_MIN = 0.8;
const timeoutMs = () => Number(process.env.FLOW_MCP_CHECK_TIMEOUT_MS) || 180000;

class Skip extends Error {}

function scriptsDir(): string {
  const d = process.env.SINEMA_SCRIPTS?.trim();
  if (!d) throw new Skip("SINEMA_SCRIPTS belum diatur");
  return d;
}

// Satu tenggat total per job untuk SEMUA cek (pencarian frame turunan + cek pasca-unduh), agar antrean bersama tidak
// tertahan puluhan menit oleh cek berurutan. Dihitung dari waktu yang benar-benar dipakai skrip cek, per job id
// (retry job yang sama berbagi tenggat).
export type CheckBudget = { left: number };
const jobBudgetMs = () => Number(process.env.FLOW_MCP_JOB_CHECK_BUDGET_MS) || 600000;
const budgets = new Map<string, CheckBudget>();
export function checkBudget(jobId: string): CheckBudget {
  let b = budgets.get(jobId);
  if (!b) {
    b = { left: jobBudgetMs() };
    budgets.set(jobId, b);
    if (budgets.size > 500) budgets.delete(budgets.keys().next().value!);
  }
  return b;
}
export const DEADLINE = "tenggat job";

/** Jalankan satu skrip (berurutan, nice -n 10) dan kembalikan stdout mentah. Tenggat job habis -> Skip("tenggat job"). */
async function runRaw(name: string, args: string[], budget?: CheckBudget): Promise<string> {
  const script = join(scriptsDir(), name);
  if (!existsSync(script)) throw new Skip(`${name} tidak terpasang`);
  if (budget && budget.left <= 0) throw new Skip(DEADLINE);
  const limit = budget ? Math.min(timeoutMs(), budget.left) : timeoutMs();
  const byBudget = !!budget && budget.left < timeoutMs();
  const t0 = Date.now();
  // Grup proses sendiri (detached): saat timeout seluruh grup dimatikan, agar anak Python tidak jadi yatim yang memakan CPU.
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("nice", ["-n", "10", "uv", "run", script, ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.on("data", (d) => { if (stdout.length < 1 << 24) stdout += d; });
      child.stderr.on("data", (d) => { if (stderr.length < 1 << 20) stderr += d; });
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, limit);
      child.on("error", (e) => { clearTimeout(timer); reject(new Skip(`${name} gagal: ${e.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Skip(byBudget ? DEADLINE : "batas waktu"));
        // cek_ucapan keluar non-nol bila MERAH; JSON di stdout tetap valid -> pakai bila ada.
        if (code !== 0 && !stdout.trim()) return reject(new Skip(`${name} gagal: ${stderr.trim().split("\n").pop() || `keluar kode ${code}`}`));
        resolve(stdout);
      });
    });
  } finally {
    if (budget) budget.left -= Date.now() - t0;
  }
}

/** Seperti runRaw, lalu JSON dari BARIS TERAKHIR stdout. */
async function runScript(name: string, args: string[], budget?: CheckBudget): Promise<unknown> {
  const out = await runRaw(name, args, budget);
  const last = out.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  try { return JSON.parse(last); } catch { throw new Skip(`${name}: keluaran bukan JSON`); }
}

// Argv cek_konsisten: tiap acuan sebagai `--ref refN=<jalur>` (bentuk eksplisit, normalisasi_argv tidak menebak mana
// acuan dan mana berkas), lalu berkas yang diperiksa sebagai argumen posisi.
export const konsistenArgs = (images: string[], refs: string[]) =>
  ["--json", "--min-mirip", String(FACE_MIN), ...refs.flatMap((r, i) => ["--ref", `ref${i + 1}=${r}`]), ...images];

/** Skor wajah (median kemiripan) gambar/klip terhadap referensi; null bila wajah tak terdeteksi. */
export async function faceScore(image: string, refs: string[], budget?: CheckBudget): Promise<number | null> {
  const r = (await runScript("cek_konsisten.py", konsistenArgs([image], refs), budget)) as { median?: number | null; face?: number | null };
  const v = r.median ?? r.face ?? null;
  return typeof v === "number" ? v : null;
}

/**
 * Skor wajah banyak gambar dalam SATU panggilan cek_konsisten (model dimuat sekali). JSON skrip hanya memberi nilai
 * terburuk, jadi skor per berkas dibaca dari baris `mirip <nama berkas> <nilai>` yang dicetak --min-mirip.
 * Nilai 0 (tanpa wajah) / baris hilang -> null. Nama berkas harus unik.
 */
export async function faceScores(images: string[], refs: string[], budget?: CheckBudget): Promise<(number | null)[]> {
  if (!images.length) return [];
  const out = await runRaw("cek_konsisten.py", konsistenArgs(images, refs), budget);
  const got = new Map<string, number>();
  for (const m of out.matchAll(/^mirip (\S+) (-?\d+(?:\.\d+)?)\s*$/gm)) got.set(m[1], Number(m[2]));
  return images.map((f) => {
    const v = got.get(basename(f));
    return v !== undefined && v > 0 ? v : null;
  });
}

registerFaceScores(faceScores);

/** Durasi klip (ffprobe, async); gagal -> 10 dtk (klip Flow terpanjang), agar ucapan di detik 6-10 tetap terdengar. */
async function clipSeconds(file: string): Promise<number> {
  const s = await new Promise<number>((resolve) => {
    execFile(process.env.FLOW_MCP_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 20_000 }, (e, stdout) =>
      resolve(e ? NaN : Number(String(stdout).trim())));
  });
  return Number.isFinite(s) && s > 0 ? Math.ceil(s * 100) / 100 : 10;
}

const reason = (e: unknown) => (e instanceof Skip ? e.message : `error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);

export async function postChecks(file: string, projectDir: string, shot: Shot, budget?: CheckBudget): Promise<string[]> {
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
    const v = await faceScore(file, refs, budget);
    if (v === null) throw new Skip("wajah tidak terdeteksi");
    qa.face_median = v;
    notes.push(v < FACE_MIN ? `wajah median ${v.toFixed(2)} < ${FACE_MIN.toFixed(2)} (review)` : `wajah median ${v.toFixed(2)}`);
  } catch (e) { skip("wajah", e); }

  // ucapan: hanya bila ada beat ber-says
  const lines = shot.beats.map((b) => b.says?.trim()).filter((x): x is string => !!x);
  if (lines.length) {
    try {
      const dur = await clipSeconds(file);
      const r = (await runScript("cek_ucapan.py", [file, lines.join(" "), "--durasi", String(dur), "--json"], budget)) as { pass?: boolean; words_ok?: boolean; rise?: number | null; heard?: string };
      const line = r.pass ? "ucapan LULUS" : `ucapan MERAH: ${r.words_ok === false ? "kata tidak cocok" : "nada tanya tidak naik"}${r.rise != null ? ` (naik ${r.rise}x)` : ""}, terdengar "${r.heard ?? ""}"`;
      qa.speech = line;
      notes.push(line);
    } catch (e) { skip("ucapan", e); }
  }

  // suara: hanya bila ada voice_ref (informasi)
  const withVoice = cast.find((c) => c.voice_ref);
  if (withVoice) {
    try {
      const r = (await runScript("cek_suara.py", [resolvePrivate(projectDir, withVoice.voice_ref!), file, "--json"], budget)) as { similarity?: number }[];
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
    // 5b. stderr kosong + exit non-nol -> alasan tidak kosong; anak proses dimatikan saat timeout
    py("cek_konsisten.py", "raise SystemExit(3)\n");
    n = await postChecks(join(proj, "S01.mp4"), proj, shots[0]);
    assert(n.some((l) => l.startsWith("dilewati: wajah (") && !l.endsWith(": )") && !l.includes(": )")), `alasan kosong: ${n}`);
    const pidFile = join(root, "anak.pid");
    py("cek_konsisten.py", `import subprocess, time\np = subprocess.Popen(["sleep", "30"])\nopen(${JSON.stringify(pidFile)}, "w").write(str(p.pid))\ntime.sleep(30)\n`);
    n = await postChecks(join(proj, "S01.mp4"), proj, shots[0]);
    assert(n.includes("dilewati: wajah (batas waktu)"), `timeout anak: ${n}`);
    const kid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try { process.kill(kid, 0); } catch { alive = false; }
    assert(!alive, "anak proses (sleep 30) harus mati bersama grupnya");
    // 5c. cek ulang yang dilewati menghapus face_median lama
    assert(readQa(proj).S01.clips!["S01.mp4"].face_median === undefined, "face_median lama terhapus saat cek ulang dilewati");
    // 6. shot tanpa pemeran/dialog: hanya wajah dilewati
    n = await postChecks(join(proj, "S01.mp4"), proj, shots[1]);
    assert(n.length === 1 && n[0].includes("tanpa referensi wajah"), `S02: ${n}`);
    // 7. cek_ucapan menerima --durasi = durasi klip (ffprobe), bukan bawaan 6 dtk skrip
    process.env.FLOW_MCP_CHECK_TIMEOUT_MS = "20000";
    const { execFileSync } = await import("node:child_process");
    const clip8 = join(proj, "S01-8s.mp4");
    execFileSync("nice", ["-n", "10", process.env.FLOW_MCP_FFMPEG ?? "ffmpeg", "-v", "error", "-y", "-threads", "4", "-f", "lavfi", "-i", "testsrc=duration=8:size=64x64:rate=10", "-pix_fmt", "yuv420p", clip8]);
    const argvFile = join(root, "argv.json");
    const echoArgv = (json: string) => `import sys, json\nopen(${JSON.stringify(argvFile)}, "a").write(json.dumps(sys.argv[1:]) + "\\n")\nprint(${JSON.stringify(json)})\n`;
    py("cek_ucapan.py", echoArgv('{"words_ok": true, "rise": null, "pass": true, "heard": "kopi pagi enak sekali"}'));
    n = await postChecks(clip8, proj, shots[0]);
    const ua = JSON.parse(readFileSync(argvFile, "utf8").trim().split("\n").pop()!) as string[];
    assert(ua[0] === clip8 && ua[1] === "Kopi pagi enak sekali" && ua[ua.indexOf("--durasi") + 1] === "8" && ua.includes("--json"), `argv ucapan: ${JSON.stringify(ua)}`);
    // 8. tenggat total per job: habis di tengah -> sisa cek "dilewati: ... (tenggat job)"
    fixed("cek_suara.py", '[{"file": "S01.mp4", "similarity": 0.71}]');
    py("cek_konsisten.py", "import time\ntime.sleep(5)\n");
    const b = { left: 1500 };
    const t0 = Date.now();
    n = await postChecks(clip8, proj, shots[0], b);
    assert(Date.now() - t0 < 4500, "tenggat memotong cek wajah");
    for (const w of ["wajah", "ucapan", "suara"]) assert(n.includes(`dilewati: ${w} (tenggat job)`), `tenggat ${w}: ${n}`);
    assert(b.left <= 0, "tenggat terpakai");
    assert(checkBudget("jx") === checkBudget("jx") && checkBudget("jx").left === 600000, "tenggat bawaan 600000 ms, satu per job id");
    // 9. skor wajah banyak kandidat dalam SATU panggilan (baris "mirip <berkas> <nilai>")
    rmSync(argvFile, { force: true });
    py("cek_konsisten.py", `import sys, json\nopen(${JSON.stringify(argvFile)}, "a").write(json.dumps(sys.argv[1:]) + "\\n")\nfor a in sys.argv[1:]:\n    n = a.rsplit("/", 1)[-1]\n    if n.startswith("k-"): print(f"mirip {n} {0.91 if n == 'k-06.jpg' else 0.5:.3f}")\nprint(json.dumps({"face": 0.5, "median": 0.5, "merah": True}))\n`);
    const kk = ["k-01.jpg", "k-06.jpg", "k-07.jpg"].map((f) => join(root, f));
    const sc = await faceScores(kk, [join(proj, "ref.jpg"), join(proj, "voice.wav")]);
    assert(JSON.stringify(sc) === "[0.5,0.91,0.5]", `skor per berkas: ${sc}`);
    const ka = readFileSync(argvFile, "utf8").trim().split("\n");
    assert(ka.length === 1 && ka[0].includes('"--ref", "ref2=') && ka[0].endsWith(`${JSON.stringify(kk[2])}]`), `satu panggilan, --ref eksplisit: ${ka}`);
    // 10. pencarian frame turunan: satu panggilan untuk semua kandidat; tenggat habis -> gagal sebelum Flow
    const { resolveFrameRef } = await import("./produksi.js");
    writeFileSync(join(proj, "produksi.json"), JSON.stringify({ ...prod, shots: prod.shots.map((x) => (x.id === "S01" ? { ...x, chosen: "S01-8s.mp4" } : x)) }));
    rmSync(argvFile, { force: true });
    const fr = await resolveFrameRef(proj, "shot:S01@1.0", undefined, { budget: { left: 60000 } });
    assert(fr.face === 0.91 && fr.at === 1 && readFileSync(argvFile, "utf8").trim().split("\n").length === 1, `frame terbaik ${fr.at} ${fr.face}`);
    let fm = "";
    try { await resolveFrameRef(proj, "shot:S01@1.0", undefined, { budget: { left: 0 } }); } catch (e) { fm = (e as Error).message; }
    assert(fm.includes("tenggat job"), `tenggat habis -> pencarian gagal: ${fm}`);
    // 11. kontrak skrip ASLI (bila SINEMA_SCRIPTS menunjuk plugin terpasang): argv yang dikirim diterima parser-nya
    const real = saved.s;
    if (real && existsSync(join(real, "cek_konsisten.py")) && existsSync(join(real, "cek_ucapan.py"))) {
      const src = readFileSync(join(real, "cek_ucapan.py"), "utf8");
      assert(src.includes('a = [x for x in a if x != "--json"]') && src.includes("src, naskah = a[0], a[1]") && src.includes('a.index("--durasi") + 1'), "cek_ucapan.py: posisi klip/naskah + --durasi di mana saja");
      const probe = `import ast, argparse, json, sys\nsrc = open(sys.argv[1]).read()\nfn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == "normalisasi_argv")\nns = {"Path": __import__("pathlib").Path}\nexec(compile(ast.Module([fn], []), "x", "exec"), ns)\nap = argparse.ArgumentParser(); ap.add_argument("--ref", action="append", default=[]); ap.add_argument("--min-mirip", type=float); ap.add_argument("--json", action="store_true"); ap.add_argument("items", nargs="+")\no = ap.parse_args(ns["normalisasi_argv"](json.loads(sys.argv[2])))\nprint(json.dumps({"ref": o.ref, "items": o.items}))\n`;
      const imgs = ["/a/k-01.jpg", "/a/k-02.jpg"], refs = ["/r/wajah=1.jpg", "/r/b.jpg"];
      const got = JSON.parse(execFileSync("python3", ["-I", "-c", probe, join(real, "cek_konsisten.py"), JSON.stringify(konsistenArgs(imgs, refs))], { encoding: "utf8" }));
      assert(JSON.stringify(got.items) === JSON.stringify(imgs) && got.ref.length === 2 && got.ref[0] === "ref1=/r/wajah=1.jpg", `normalisasi_argv cek_konsisten: ${JSON.stringify(got)}`);
      const pyMain = readFileSync(join(real, "cek_konsisten.py"), "utf8");
      assert(pyMain.includes('print(f"mirip {f.name} {nilai:.3f}")') && pyMain.includes('r.split("=", 1)'), "cek_konsisten.py mencetak mirip per berkas dan memecah --ref di '=' pertama");
      console.log("kontrak skrip asli ok");
    } else console.log("kontrak skrip asli dilewati (SINEMA_SCRIPTS tidak menunjuk plugin)");
    console.log("periksa ok");
  } finally {
    if (saved.s === undefined) delete process.env.SINEMA_SCRIPTS; else process.env.SINEMA_SCRIPTS = saved.s;
    if (saved.t === undefined) delete process.env.FLOW_MCP_CHECK_TIMEOUT_MS; else process.env.FLOW_MCP_CHECK_TIMEOUT_MS = saved.t;
  }
}
