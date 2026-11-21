// produksi.json: schema + lint (tahap 1). Opt-in: a project without the file behaves as before.
// Self-check: `node dist/produksi.js --cek`
import { execFile } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { techniqueById } from "./techniques.js";

export const SCALES = ["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"] as const;
export const JOIN_TYPES = ["cut", "cut-on-action", "match-cut", "invisible", "push-through", "rack-focus", "whip", "dissolve", "dip"] as const;
export const STAGES = ["mulai", "konsep", "kunci", "naskah", "shotlist", "keyframe", "uji", "generate", "qa", "suara", "rakit", "serah"] as const;

const Beat = z.strictObject({
  at: z.tuple([z.number(), z.number()]),
  action: z.string(),
  says: z.string().nullish(),
});
const Cast = z.strictObject({
  identity: z.string(),
  voice: z.string().optional(),
  real_person: z.boolean().default(false),
  consent: z.string().nullish(),
  photos: z.array(z.string()).optional(),
  face_refs: z.record(z.string(), z.string()).default({}),
  voice_ref: z.string().nullish(),
  wardrobe: z.record(z.string(), z.string()).default({}),
});
const Prop = z.strictObject({
  description: z.string(),
  refs: z.array(z.string()).default([]),
  invariant: z.string().optional(),
});
const World = z.strictObject({
  location: z.string(),
  light: z.string(),
  ambience: z.string().optional(),
});
const Shot = z.strictObject({
  id: z.string(),
  world: z.string(),
  cast: z.array(z.string()).default([]),
  props: z.array(z.string()).default([]),
  angle: z.string(),
  move: z.string().nullish(),
  scale: z.enum(SCALES),
  expression: z.string().optional(),
  screen_dir: z.enum(["L>R", "R>L"]).optional(),
  beats: z.array(Beat).default([]),
  sfx: z.array(z.strictObject({ at: z.number(), sound: z.string() })).default([]),
  start: z.string().nullish(),
  end: z.string().nullish(),
  join: z.strictObject({ type: z.enum(JOIN_TYPES), at_prev: z.number().optional(), audio: z.enum(["j", "l"]).optional() }).optional(),
  tier: z.enum(["draft", "final", "hero"]).default("final"),
  chosen: z.string().nullish(),
  range: z.unknown().optional(),
});

export const ProductionSchema = z.strictObject({
  version: z.literal(1),
  title: z.string(),
  aspect_ratio: z.string(),
  stage: z.enum(STAGES),
  budget_credits: z.number().nonnegative().optional(),
  dialogue_max_words: z.number().int().positive().default(5),
  music: z.boolean().default(false),
  camera: z.string(),
  cast: z.record(z.string(), Cast).default({}),
  props: z.record(z.string(), Prop).default({}),
  worlds: z.record(z.string(), World).default({}),
  shots: z.array(Shot).default([]),
  decisions: z.array(z.strictObject({ date: z.string(), stage: z.string(), text: z.string() })).default([]),
});
export type Production = z.infer<typeof ProductionSchema>;
export type Issue = { level: "error" | "warning"; shot?: string; code: string; message: string };

export function loadProduction(projectDir: string): Production | undefined {
  const f = join(projectDir, "produksi.json");
  if (!existsSync(f)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    throw new Error(`produksi.json: ${f}: JSON tidak valid (${(e as Error).message})`);
  }
  const r = ProductionSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`produksi.json: ${i.path.join(".") || "(akar)"}: ${i.message} (berkas: ${f})`);
  }
  return r.data;
}

// Same default as OUTPUT_ROOT in core.ts, recomputed here so this module stays free of the heavy core imports.
const outputRoot = () => process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
const privateRoot = () => resolve(process.env.SINEMA_PRIVATE_ROOT ?? dirname(resolve(outputRoot())));

export function resolvePrivate(projectDir: string, ref: string): string {
  if (ref.startsWith("privat:")) {
    const base = join(privateRoot(), "talent-privat", basename(resolve(projectDir)));
    const full = resolve(base, ref.slice(7));
    if (full !== base && !full.startsWith(base + sep)) throw new Error(`privat: jalur keluar dari folder privat: ${ref}`);
    return full;
  }
  return resolve(projectDir, ref);
}

const wordCount = (s: string) => s.replace(/[^\p{L}\p{N}\s'-]+/gu, " ").split(/\s+/).filter(Boolean).length;
const hasRef = (v: string | null | undefined) => !!v && v.trim() !== "";

export function lint(p: Production, exists: (path: string) => boolean, projectDir: string): Issue[] {
  const out: Issue[] = [];
  const add = (level: Issue["level"], code: string, message: string, shot?: string) => out.push({ level, code, message, ...(shot ? { shot } : {}) });
  const err = (code: string, message: string, shot?: string) => add("error", code, message, shot);
  const warn = (code: string, message: string, shot?: string) => add("warning", code, message, shot);

  for (const [name, c] of Object.entries(p.cast)) {
    if (!c.real_person) continue;
    let consentOk = false;
    try { consentOk = hasRef(c.consent) && exists(resolvePrivate(projectDir, c.consent!)); } catch { /* jalur keluar folder privat */ }
    if (!consentOk) err("E_CONSENT", `pemeran '${name}' real_person tanpa berkas consent yang ada`);
    for (const ph of c.photos ?? []) if (!ph.startsWith("privat:")) err("E_PHOTOS_PUBLIC", `pemeran '${name}': foto asli '${ph}' harus berawalan privat:`);
  }
  for (const [name, w] of Object.entries(p.worlds)) if (!hasRef(w.ambience)) warn("W_NO_AMBIENCE", `dunia '${name}' tanpa ambience`);

  let prev: Production["shots"][number] | undefined;
  const seen = new Set<string>();
  for (const s of p.shots) {
    const id = s.id;
    if (seen.has(id)) err("E_ID", `id shot '${id}' ganda`, id);
    seen.add(id);
    if (!p.worlds[s.world]) err("E_ID", `world '${s.world}' tidak dikenal`, id);
    for (const c of s.cast) if (!p.cast[c]) err("E_ID", `pemeran '${c}' tidak dikenal`, id);
    for (const o of s.props) if (!p.props[o]) err("E_ID", `objek '${o}' tidak dikenal`, id);
    const a = techniqueById(s.angle);
    if (!a || a.category !== "angle") err("E_ID", `angle '${s.angle}' tidak dikenal`, id);
    if (s.move) {
      const m = techniqueById(s.move);
      if (!m || m.category === "angle") err("E_ID", `move '${s.move}' tidak dikenal`, id);
    }
    if (s.expression) {
      for (const c of s.cast) if (p.cast[c] && !(s.expression in p.cast[c].face_refs)) err("E_ID", `ekspresi '${s.expression}' tidak ada di face_refs pemeran '${c}'`, id);
    }
    if (s.cast.length && (!hasRef(s.start) || !hasRef(s.end))) err("E_FRAMES", "shot berpemeran wajib punya start dan end (shot:/crop: dihitung ada)", id);
    let spoke = false;
    for (const b of s.beats) {
      if (!b.says) continue;
      spoke = true;
      const n = wordCount(b.says);
      if (n > p.dialogue_max_words) err("E_WORDS", `dialog '${b.says}' ${n} kata, batas ${p.dialogue_max_words}`, id);
      if (b.says.trim().endsWith("?")) warn("W_QUESTION", `baris tanya '${b.says}': cek nada naik (≥ 1,15×)`, id);
    }
    if (spoke) for (const c of s.cast) if (p.cast[c] && !hasRef(p.cast[c].voice)) warn("W_NO_VOICE", `pemeran '${c}' berdialog tanpa voice`, id);
    if (s.join?.type === "invisible" && s.join.at_prev === undefined) err("E_INVISIBLE_AT", "join invisible wajib at_prev", id);
    if (s.join?.type === "dissolve" && prev) {
      const d = Math.abs(SCALES.indexOf(s.scale) - SCALES.indexOf(prev.scale));
      if (d >= 2) err("E_DISSOLVE_SCALE", `dissolve ${prev.scale} -> ${s.scale} beda ${d} tingkat; pakai push-through / rack-focus`, id);
    }
    if (s.tier !== "draft" && p.budget_credits === undefined) err("E_BUDGET", "tier berbayar tanpa budget_credits", id);
    if (prev && prev.world === s.world && prev.angle === s.angle && prev.scale === s.scale) warn("W_SAME_ANGLE", `angle+skala sama dengan ${prev.id} di dunia yang sama`, id);
    if (s.angle === "dutch-angle" && s.move && s.move !== "static") warn("W_DUTCH_MOVE", "dutch hanya diam; jangan digabung gerak kamera", id);
    if (prev?.screen_dir && s.screen_dir && prev.screen_dir !== s.screen_dir) warn("W_SCREEN_DIR", `arah layar berbalik dari ${prev.id} tanpa shot netral`, id);
    prev = s;
  }
  if (p.shots.length && new Set(p.shots.map((s) => s.angle)).size < 2) warn("W_FEW_ANGLES", "kurang dari 2 angle berbeda di seluruh video");
  return out;
}

export type ClipQa = { motion?: string; face_median?: number; speech?: string; voice?: number; skipped?: string[] };
export type Label = { kind: "voice" | "ambience"; verdict: "same" | "different" | "jump" | "ok"; file?: string; at: string };
export type ShotQa = { keyframes?: { passed: boolean; face?: number; by: string; at: string }; clips?: Record<string, ClipQa>; labels?: Label[] };
export type Qa = Record<string, ShotQa>;
export type LogEntry = { t: string; job: string; shot?: string; file?: string; tier?: string; quote?: number; credits?: number; estimate?: boolean; force?: string; measured?: number };

const QA_FILE = "qa.json";
let tmpSeq = 0;
const LOG_FILE = "produksi-log.jsonl";

/** qa.json milik flow-mcp (produksi.json tidak pernah ditulis). Rusak -> error menyebut berkas+jalur. */
export function readQa(projectDir: string): Qa {
  const f = join(projectDir, QA_FILE);
  if (!existsSync(f)) return {};
  try {
    const d = JSON.parse(readFileSync(f, "utf8"));
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("bukan objek");
    return d as Qa;
  } catch (e) {
    throw new Error(`${QA_FILE} rusak (${f}): ${(e as Error).message}`);
  }
}

/** Gabung patch ke shot: baca ulang disk, clips digabung per berkas+kolom, labels ditambah; tulis .tmp lalu rename. */
export function mergeQa(projectDir: string, shot: string, patch: Partial<ShotQa>): void {
  const qa = readQa(projectDir);
  const cur: ShotQa = qa[shot] ?? {};
  const next: ShotQa = { ...cur };
  if (patch.keyframes) next.keyframes = patch.keyframes;
  if (patch.clips) {
    const clips: Record<string, ClipQa> = { ...(cur.clips ?? {}) };
    for (const [k, v] of Object.entries(patch.clips)) clips[k] = { ...(clips[k] ?? {}), ...v };
    next.clips = clips;
  }
  if (patch.labels) next.labels = [...(cur.labels ?? []), ...patch.labels];
  qa[shot] = next;
  const f = join(projectDir, QA_FILE);
  const tmp = `${f}.${process.pid}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, JSON.stringify(qa, null, 2) + "\n");
  renameSync(tmp, f);
}

export function appendLog(projectDir: string, entry: LogEntry): void {
  appendFileSync(join(projectDir, LOG_FILE), JSON.stringify(entry) + "\n");
}

function readLog(projectDir: string): LogEntry[] {
  const f = join(projectDir, LOG_FILE);
  if (!existsSync(f)) return [];
  const out: LogEntry[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as LogEntry); } catch { /* baris rusak dilewati */ }
  }
  return out;
}

/** Kredit terpakai: hanya entri ber-file (job selesai), sekali per job id (retry tak menggandakan). `measured` (selisih saldo) diabaikan. */
export function spentCredits(projectDir: string): number {
  const byJob = new Map<string, number>();
  for (const e of readLog(projectDir)) {
    if (!e.file) continue;
    const v = e.credits ?? e.quote;
    // Entri belakangan tanpa harga (mis. berkas varian kedua) tidak menghapus harga yang sudah tercatat.
    if (v !== undefined) byJob.set(e.job, v);
    else if (!byJob.has(e.job)) byJob.set(e.job, 0);
  }
  let sum = 0;
  for (const v of byJob.values()) sum += v;
  return sum;
}

/** Berkas terbaru (urutan berkas log) untuk shot itu yang punya `file`. */
export function latestClip(projectDir: string, shot: string): string | undefined {
  const l = readLog(projectDir).filter((e) => e.shot === shot && e.file);
  return l.length ? l[l.length - 1].file : undefined;
}

// ---- Gerbang G1-G3 (tahap 1). Hanya aktif bila project punya produksi.json. ----

export type GateScene = { shot?: string; force?: string; tier?: string; type: string; model?: string; first_frame?: string; last_frame?: string };
export type GateResult = { ok: true; force?: string; derived?: true } | { ok: false; reason: string };

/** Video berbayar = video selain tier draft (tanpa tier = model Flow saat ini, dianggap berbayar). */
export const paidVideo = (s: { type: string; tier?: string }) => s.type === "video" && s.tier !== "draft";

/**
 * G1 (lint shot bersih) + G2 (keyframe lulus di qa.json) untuk satu scene, sebelum job dibuat.
 * Tanpa produksi.json -> selalu ok (opt-in). produksi.json/qa.json rusak -> semua job project itu ditolak.
 * `force` (alasan tak kosong) melewati G1/G2 saja; G3 (anggaran) dicek terpisah saat quote dan tak bisa di-force.
 */
export function gate(projectDir: string, scene: GateScene): GateResult {
  let p: Production | undefined;
  try {
    p = loadProduction(projectDir);
  } catch (e) {
    return { ok: false, reason: `${(e as Error).message}. Perbaiki berkas itu dulu; tidak ada job yang dibuat.` };
  }
  if (!p || !paidVideo(scene)) return { ok: true };
  const force = scene.force?.trim();
  if (force) return { ok: true, force };
  if (!scene.shot) return { ok: false, reason: "Mode produksi: video berbayar wajib shot (mis. shot: \"S01\"), atau tier: \"draft\" (gratis), atau force: \"<alasan>\"." };
  const id = scene.shot;
  if (!p.shots.some((s) => s.id === id)) return { ok: false, reason: `Mode produksi: shot '${id}' tidak ada di produksi.json.` };
  const errors = lint(p, (f) => existsSync(f), projectDir).filter((i) => i.level === "error" && (i.shot === id || !i.shot));
  if (errors.length) {
    return { ok: false, reason: `G1 ${id}: error lint ${errors.map((i) => `${i.code} (${i.message})`).join("; ")}. Perbaiki produksi.json, atau force: "<alasan>".` };
  }
  let qa: Qa;
  try {
    qa = readQa(projectDir);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  // Pasangan turunan (START shot: + END crop:, shot berwajah): G2 diverifikasi mesin saat job jalan (resolveSceneFrames);
  // wajah < 0,80 membuat job gagal sebelum Flow dibuka, jadi tidak ada kredit terpakai.
  if (qa[id]?.keyframes?.passed !== true && derivedPair(scene) && faceRefs(projectDir, p, id).length) return { ok: true, derived: true };
  if (qa[id]?.keyframes?.passed !== true) {
    return { ok: false, reason: `G2 ${id}: pasangan keyframe START/END belum lulus di qa.json. Jalankan cek pasangan dulu, atau force: "<alasan>".` };
  }
  return { ok: true };
}

/** Sisa anggaran kredit; undefined = bukan mode produksi. budget_credits kosong dihitung 0. Berkas rusak -> melempar. */
export function budgetLeft(projectDir: string): number | undefined {
  const p = loadProduction(projectDir);
  if (!p) return undefined;
  return (p.budget_credits ?? 0) - spentCredits(projectDir);
}

/**
 * G3 di titik quote Flow (hanya video; draft = quote 0 lolos). Tanpa produksi.json -> ok. Tak bisa di-force.
 * produksi.json rusak -> ditolak dengan jalur berkas.
 */
export function g3Check(projectDir: string, quote: number, scene: { type: string }): { ok: true } | { ok: false; reason: string } {
  if (scene.type !== "video") return { ok: true };
  let left: number | undefined;
  try {
    left = budgetLeft(projectDir);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return left !== undefined && overBudget(left, quote) ? { ok: false, reason: budgetMessage(left, quote) } : { ok: true };
}

/** G3: quote 0 (draft) tak pernah ditolak. */
export const overBudget = (left: number, quote: number): boolean => quote > 0 && quote > left;

export const budgetMessage = (left: number, quote: number, what = "quote") =>
  `Anggaran project habis: sisa ${left}, ${what} ${quote}. Naikkan budget_credits di produksi.json setelah user setuju.`;

// Alat berbayar tanpa quote Flow: perkiraan konservatif sebelum jalan.
export const EDIT_CREDITS_PER_S = 5; // diukur: klip 4 dtk = 20 kredit
export const EDIT_MAX_SECONDS = 10; // klip Flow terpanjang (Omni 10 dtk)
export const EXTEND_CREDITS = 24; // harga klip Omni 1.2 Flash, 8 dtk
export function estimateCost(kind: "edit" | "continue", seconds?: number): number {
  if (kind === "continue") return EXTEND_CREDITS;
  return EDIT_CREDITS_PER_S * Math.ceil(seconds && seconds > 0 ? seconds : EDIT_MAX_SECONDS);
}
export const MEASURED_NOTE = "biaya terukur dari saldo, bisa termasuk pemakaian tim";

// ---- Rujukan frame turunan (tahap 1): first_frame/last_frame "shot:S02@4.2" dan "crop:1.10". Hanya mode produksi. ----

export const FRAME_WINDOW_S = 0.5; // frame dicari ±0,5 dtk dari titik yang diminta
const FRAME_FPS = 10; // tiap 0,1 dtk
export const FACE_PASS = 0.8;
type FaceScorer = (image: string, refs: string[]) => Promise<number | null>;
let faceScorer: FaceScorer | undefined;
/** Uji: ganti faceScore (periksa.ts) dengan tiruan; undefined = kembali ke skrip cek_konsisten sungguhan. */
export function setFaceScorer(f?: FaceScorer): void {
  faceScorer = f;
}
// Impor dinamis: periksa.ts mengimpor modul ini, jadi impor statis akan melingkar.
const scoreFace: FaceScorer = async (img, refs) => (faceScorer ?? (await import("./periksa.js")).faceScore)(img, refs);

const SHOT_REF = /^shot:([A-Za-z0-9_-]+)(?:@(\d+(?:\.\d+)?))?$/;
const CROP_REF = /^crop:(\d+(?:\.\d+)?)$/;
const isShotRef = (v?: string) => !!v && v.startsWith("shot:");
const isCropRef = (v?: string) => !!v && v.startsWith("crop:");
export const isDerivedRef = (v?: string) => isShotRef(v) || isCropRef(v);
/** START dari klip shot lain + END crop (atau kebalikannya, pull-back): pasangan yang diverifikasi mesin saat job jalan. */
export const derivedPair = (s: { first_frame?: string; last_frame?: string }) =>
  (isShotRef(s.first_frame) && isCropRef(s.last_frame)) || (isCropRef(s.first_frame) && isShotRef(s.last_frame));

type FrameRef = { kind: "shot"; shot: string; at?: number } | { kind: "crop"; factor: number };
function parseFrameRef(ref: string): FrameRef {
  const m = ref.match(SHOT_REF);
  if (m) return { kind: "shot", shot: m[1], at: m[2] !== undefined ? Number(m[2]) : undefined };
  const c = ref.match(CROP_REF);
  if (c) {
    const factor = Number(c[1]);
    if (!(factor > 1 && factor <= 4)) throw new Error(`crop:${c[1]}: faktor harus > 1 dan ≤ 4 (mis. crop:1.10)`);
    return { kind: "crop", factor };
  }
  if (ref.startsWith("shot:")) throw new Error(`rujukan '${ref}' tidak dikenal; bentuknya shot:S02@4.2 atau shot:S02`);
  throw new Error(`rujukan '${ref}' tidak dikenal; bentuknya crop:1.10`);
}

const needProduction = (projectDir: string): Production => {
  const p = loadProduction(projectDir);
  if (!p) throw new Error(`Rujukan shot:/crop: hanya untuk project ber-produksi.json (tidak ada di ${projectDir}). Pakai jalur gambar/klip biasa.`);
  return p;
};

/** Klip sumber shot: `chosen` di produksi.json, atau klip terbaru shot itu di log. */
function sourceClip(projectDir: string, p: Production, shot: string): string {
  const chosen = p.shots.find((s) => s.id === shot)?.chosen?.trim();
  if (chosen) {
    const f = resolve(projectDir, chosen);
    if (!existsSync(f)) throw new Error(`klip terpilih ${shot} (${chosen}) tidak ada di ${projectDir}; perbaiki chosen di produksi.json`);
    return f;
  }
  const latest = latestClip(projectDir, shot);
  const f = latest ? resolve(projectDir, latest) : undefined;
  if (!f || !existsSync(f)) throw new Error(`${shot} belum punya klip; jalankan setelah klip induk dipilih`);
  return f;
}

type FrameScene = { first_frame?: string; first_frame_at?: number; last_frame?: string; shot?: string; crop_center?: [number, number] };

/** Validasi cepat saat generate() (tanpa ffmpeg): sintaks, mode produksi, klip induk ada, crop punya frame lawan lokal. */
export function checkFrameRefs(projectDir: string, scene: FrameScene): void {
  const { first_frame: ff, last_frame: lf } = scene;
  if (!isDerivedRef(ff) && !isDerivedRef(lf)) return;
  const p = needProduction(projectDir);
  if (isCropRef(ff) && isCropRef(lf)) throw new Error("first_frame dan last_frame tidak bisa sama-sama crop:; salah satunya harus frame sumber");
  for (const [ref, other] of [[ff, lf], [lf, ff]] as const) {
    if (!ref || !isDerivedRef(ref)) continue;
    const r = parseFrameRef(ref);
    if (r.kind === "shot") sourceClip(projectDir, p, r.shot);
    else if (!other) throw new Error(`${ref} butuh frame lawan (first_frame/last_frame) untuk di-crop`);
    else if (other.startsWith("asset:")) throw new Error(`${ref} butuh frame lawan berupa berkas lokal atau shot:, bukan asset: (${other})`);
  }
}

const execFileP = promisify(execFile);
const ffmpegBin = () => process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const ffprobeBin = () => process.env.FLOW_MCP_FFPROBE ?? "ffprobe";
async function ffmpeg(args: string[]): Promise<void> {
  try {
    await execFileP("nice", ["-n", "10", ffmpegBin(), "-v", "error", "-y", "-threads", "4", ...args], { timeout: 120_000 });
  } catch (e) {
    throw new Error(`frame turunan butuh ffmpeg: ${(e as Error).message.split("\n")[0]}`);
  }
}
async function probe(file: string, entries: string): Promise<string> {
  const { stdout } = await execFileP(ffprobeBin(), ["-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0:s=x", file], { timeout: 20_000 });
  return String(stdout).trim();
}
const turunanDir = (projectDir: string) => {
  const d = join(projectDir, "frame", "turunan");
  mkdirSync(d, { recursive: true });
  return d;
};

/** Referensi wajah: face_refs[expression] tiap pemeran shot (jalur privat: diselesaikan). */
function faceRefs(projectDir: string, p: Production, shot?: string): string[] {
  const s = p.shots.find((x) => x.id === shot);
  if (!s?.expression) return [];
  return s.cast.map((c) => p.cast[c]?.face_refs[s.expression!]).filter((r): r is string => !!r).map((r) => resolvePrivate(projectDir, r));
}

// strict: pasangan turunan -> ref wajah HANYA dari shot tujuan (tanpa cadangan shot sumber); tanpa ref = melempar.
// tag: id job, masuk nama berkas agar job yang berjalan bersamaan tidak saling menimpa.
export type FrameOpts = { target?: string; role?: "start" | "end"; source?: string; center?: [number, number]; strict?: boolean; tag?: string };

/**
 * `shot:S02@4.2` -> frame dari klip S02 (chosen / terbaru) dalam 4,2 ± 0,5 dtk (tanpa @: 0,5 dtk terakhir) dengan skor
 * wajah tertinggi terhadap pemeran shot tujuan (`target`, bawaan shot sumber). < 0,80 / tak terdeteksi -> melempar dengan
 * saran cut-on-action. Shot tanpa face_refs: frame tepat di titik itu, tanpa skor.
 * `crop:1.10` -> `source` diperbesar 1,10× (pusat `center` 0..1, kotak dijepit di dalam gambar), ukuran tetap.
 */
export async function resolveFrameRef(projectDir: string, ref: string, at?: number, opts: FrameOpts = {}): Promise<{ path: string; face?: number; at?: number }> {
  const p = needProduction(projectDir);
  const r = parseFrameRef(ref);
  const outDir = turunanDir(projectDir);
  if (r.kind === "crop") {
    const src = opts.source;
    if (!src || src.startsWith("asset:") || !existsSync(src)) throw new Error(`${ref}: frame sumber untuk di-crop tidak ada (${src ?? "kosong"})`);
    const [W, H] = (await probe(src, "stream=width,height")).split("x").map(Number);
    if (!(W > 0 && H > 0)) throw new Error(`${ref}: ukuran gambar sumber tak terbaca (${src})`);
    const [cx, cy] = opts.center ?? [0.5, 0.5];
    const w = Math.round(W / r.factor), h = Math.round(H / r.factor);
    const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
    const x = clamp(Math.round(cx * W - w / 2), W - w), y = clamp(Math.round(cy * H - h / 2), H - h);
    const stem = basename(src).replace(/\.[^.]+$/, "");
    const out = join(outDir, `${stem}-crop-${r.factor.toFixed(2)}${opts.tag && !stem.endsWith(`-${opts.tag}`) ? `-${opts.tag}` : ""}.png`);
    await ffmpeg(["-i", src, "-vf", `crop=${w}:${h}:${x}:${y},scale=${W}:${H}:flags=lanczos`, "-frames:v", "1", out]);
    return { path: out };
  }
  const clip = sourceClip(projectDir, p, r.shot);
  const dur = Number(await probe(clip, "format=duration").catch(() => ""));
  if (!(dur > 0)) throw new Error(`durasi klip ${clip} tak terbaca`);
  const want = at ?? r.at;
  if (want !== undefined && want > dur) throw new Error(`${ref}: ${want} dtk di luar durasi klip ${r.shot} (${dur.toFixed(2)} dtk)`);
  const lo = want === undefined ? Math.max(0, dur - FRAME_WINDOW_S) : Math.max(0, want - FRAME_WINDOW_S);
  const hi = want === undefined ? dur : Math.min(dur, want + FRAME_WINDOW_S);
  const center = want ?? dur;
  const tmp = mkdtempSync(join(outDir, "kandidat-"));
  try {
    await ffmpeg(["-ss", lo.toFixed(3), "-i", clip, "-t", (hi - lo).toFixed(3), "-vf", `fps=${FRAME_FPS}`, "-q:v", "2", join(tmp, "k-%02d.jpg")]);
    const cands = readdirSync(tmp).filter((f) => /^k-\d+\.jpg$/.test(f)).sort()
      .map((f, i) => ({ file: join(tmp, f), t: Math.round((lo + i / FRAME_FPS) * 100) / 100 }));
    if (!cands.length) throw new Error(`${ref}: tak ada frame di ${lo.toFixed(2)}–${hi.toFixed(2)} dtk klip ${r.shot}`);
    const target = opts.target ?? r.shot;
    const refs = faceRefs(projectDir, p, target).length || opts.strict ? faceRefs(projectDir, p, target) : faceRefs(projectDir, p, r.shot);
    if (opts.strict && !refs.length) throw new Error(`${ref}: pasangan turunan butuh face_refs[expression] pemeran shot tujuan ${target}; isi produksi.json, atau force: "<alasan>"`);
    let best: { file: string; t: number; face?: number } | undefined;
    if (!refs.length) {
      best = cands.reduce((a, b) => (Math.abs(b.t - center) < Math.abs(a.t - center) ? b : a));
    } else {
      let failure = "";
      for (const c of cands) {
        let v: number | null;
        try { v = await scoreFace(c.file, refs); } catch (e) { v = null; failure ||= (e as Error).message.split("\n")[0]; }
        if (v !== null && (best?.face === undefined || v > best.face)) best = { ...c, face: v };
      }
      if (best?.face === undefined || best.face < FACE_PASS) {
        const why = best?.face !== undefined ? `skor wajah tertinggi ${best.face.toFixed(2)} di ${best.t.toFixed(2)} dtk` : failure ? `cek wajah gagal: ${failure}` : "wajah tidak terdeteksi";
        throw new Error(`${ref}: tak ada frame dengan wajah ≥ ${FACE_PASS.toFixed(2)} dalam ${lo.toFixed(2)}–${hi.toFixed(2)} dtk (${why}). Ganti sambungan ke cut-on-action dengan START baru.`);
      }
    }
    const name = `${opts.target ?? r.shot}-${opts.role ?? "frame"}-${r.shot}-${best.t.toFixed(2)}s${opts.tag ? `-${opts.tag}` : ""}.jpg`;
    const out = join(outDir, name);
    copyFileSync(best.file, out);
    return { path: out, face: best.face, at: best.t };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Dipanggil tepat sebelum job jalan: mengganti rujukan shot:/crop: di first_frame/last_frame dengan berkas di
 * frame/turunan/. Sisi sumber dulu, lalu crop dari hasilnya. START shot: (wajah ≥ 0,80) + END crop (atau kebalikannya)
 * -> keyframes shot tujuan dicatat lulus di qa.json (by "turunan"). Gagal -> melempar (job gagal sebelum Flow dibuka).
 */
export async function resolveSceneFrames(projectDir: string, scene: FrameScene, opts: { exempt?: boolean; tag?: string } = {}): Promise<string[]> {
  if (!isDerivedRef(scene.first_frame) && !isDerivedRef(scene.last_frame)) return [];
  checkFrameRefs(projectDir, scene);
  const p = needProduction(projectDir);
  const pair = derivedPair(scene);
  // Pasangan turunan pada job bergerbang (bukan force/draft): lulusnya hanya dari wajah pemeran shot TUJUAN.
  const strict = pair && !opts.exempt;
  if (strict && !(scene.shot && p.shots.some((s) => s.id === scene.shot)))
    throw new Error(`pasangan turunan butuh shot tujuan yang ada di produksi.json (shot: ${scene.shot ?? "kosong"})`);
  if (strict && !faceRefs(projectDir, p, scene.shot).length)
    throw new Error(`pasangan turunan butuh face_refs[expression] pemeran shot tujuan ${scene.shot}; isi produksi.json, atau force: "<alasan>"`);
  const notes: string[] = [];
  let face: number | undefined;
  // Hasil dikumpulkan dulu; scene baru diubah setelah KEDUA sisi selesai, agar kegagalan tak meninggalkan setengah
  // rujukan terselesaikan yang pada retry melewati cek wajah.
  const resolved: { first_frame?: string; last_frame?: string } = {};
  const sides = [["first_frame", "start"], ["last_frame", "end"]] as const;
  for (const crop of [false, true]) {
    for (const [key, role] of sides) {
      const ref = scene[key];
      if (!ref || isCropRef(ref) !== crop || !isDerivedRef(ref)) continue;
      const otherKey = key === "first_frame" ? "last_frame" : "first_frame";
      const other = resolved[otherKey] ?? scene[otherKey];
      const r = await resolveFrameRef(projectDir, ref, key === "first_frame" ? scene.first_frame_at : undefined, {
        target: scene.shot, role, source: other, center: scene.crop_center, strict: strict && isShotRef(ref), tag: opts.tag,
      });
      resolved[key] = r.path;
      if (r.face !== undefined) face = r.face;
      notes.push(`frame turunan ${role.toUpperCase()}: ${ref} -> ${basename(r.path)}${r.at !== undefined ? ` (${r.at.toFixed(2)} dtk)` : ""}${r.face !== undefined ? `, wajah ${r.face.toFixed(2)}` : ""}`);
    }
  }
  if (strict && face === undefined) throw new Error(`pasangan turunan ${scene.shot}: skor wajah tidak ada; jalankan cek pasangan, atau force: "<alasan>"`);
  if (resolved.first_frame) scene.first_frame = resolved.first_frame;
  if (resolved.last_frame) scene.last_frame = resolved.last_frame;
  if (pair && face !== undefined && scene.shot && p.shots.some((s) => s.id === scene.shot)) {
    mergeQa(projectDir, scene.shot, { keyframes: { passed: true, face, by: "turunan", at: new Date().toISOString() } });
    notes.push(`pasangan turunan ${scene.shot} dicatat lulus di qa.json`);
  }
  return notes;
}

const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** Laporan gratis untuk flow_production check. Tidak membuka Flow; produksi.json rusak -> { error } (tak melempar). */
export function checkReport(projectDir: string, format: "json" | "md" = "json"): object {
  let p: Production | undefined;
  let qa: Qa;
  try {
    p = loadProduction(projectDir);
    qa = readQa(projectDir);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!p) return { pipeline: false };
  if (format === "md") {
    const rows = p.shots.map((s) => {
      const dlg = s.beats.map((b) => b.says).filter(Boolean).join(" / ");
      return `| ${cell(s.id)} | ${cell(s.world)} | ${cell(`${s.angle} / ${s.scale} / ${s.move ?? "-"}`)} | ${cell(s.expression ?? "-")} | ${cell(dlg || "-")} | ${cell(s.join?.type ?? "-")} |`;
    });
    const md = [
      `# ${p.title}`,
      "",
      "> Dibangkitkan dari produksi.json — jangan disunting",
      "",
      "| id | dunia | angle/skala/gerak | ekspresi | dialog | sambungan |",
      "|---|---|---|---|---|---|",
      ...rows,
      "",
    ].join("\n");
    return { md };
  }
  const issues = lint(p, (f) => existsSync(f), projectDir);
  const spent = spentCredits(projectDir);
  const approved = p.budget_credits ?? null;
  const missing: string[] = [];
  if (approved === null) missing.push("budget_credits belum diisi");
  const shots = p.shots.map((s) => {
    const q = qa[s.id];
    const passed = q?.keyframes?.passed === true;
    const clips = Object.keys(q?.clips ?? {});
    if (!passed) missing.push(`${s.id}: keyframe belum lulus`);
    if (!s.chosen) missing.push(`${s.id}: klip belum dipilih`);
    return { id: s.id, keyframes_passed: passed, clips, chosen: s.chosen ?? null };
  });
  return {
    stage: p.stage,
    errors: issues.filter((i) => i.level === "error"),
    warnings: issues.filter((i) => i.level === "warning"),
    budget: { approved, spent, remaining: approved === null ? null : approved - spent },
    shots,
    missing,
  };
}

if (process.argv[1]?.endsWith("produksi.js") && process.argv.includes("--cek")) {
  const assert = (c: unknown, m: string) => {
    if (!c) throw new Error(`cek gagal: ${m}`);
  };
  const raw = JSON.parse(readFileSync(new URL("../fixtures/produksi.contoh.json", import.meta.url), "utf8"));
  const mk = (f?: (d: any) => void) => {
    const d = structuredClone(raw);
    f?.(d);
    return ProductionSchema.parse(d);
  };
  const yes = (_f: string) => true;
  const codes = (p: Production, ex: (f: string) => boolean = yes) => lint(p, ex, "/tmp/x");
  const has = (is: Issue[], code: string, shot?: string) => is.some((i) => i.code === code && (!shot || i.shot === shot));

  const base = codes(mk());
  assert(!base.some((i) => i.level === "error" && i.shot === "S03"), "S03 harus 0 error");
  assert(!base.some((i) => i.level === "error"), "fixture 0 error");
  assert(has(codes(mk((d) => (d.shots[0].beats[1].says = "Kopi apa ini kenapa mahal sekali?"))), "E_WORDS", "S01"), "E_WORDS");
  const ds = codes(mk((d) => { d.shots[1].scale = "ECU"; d.shots[1].join = { type: "dissolve" }; }));
  assert(has(ds, "E_DISSOLVE_SCALE", "S02"), "E_DISSOLVE_SCALE MS->ECU");
  assert(has(codes(mk((d) => (d.shots[1].join = { type: "dissolve" }))), "E_DISSOLVE_SCALE"), "MS->CU = 2 tingkat, ditolak");
  assert(!has(codes(mk((d) => { d.shots[1].scale = "MCU"; d.shots[1].join = { type: "dissolve" }; })), "E_DISSOLVE_SCALE"), "MS->MCU dissolve boleh");
  assert(has(codes(mk((d) => { d.cast.raka.real_person = true; })), "E_CONSENT"), "E_CONSENT");
  assert(has(codes(mk((d) => { d.cast.raka.real_person = true; d.cast.raka.consent = "privat:IZIN.md"; d.cast.raka.photos = ["talent/a.jpg"]; })), "E_PHOTOS_PUBLIC"), "E_PHOTOS_PUBLIC");
  let asked = "";
  codes(mk((d) => { d.cast.raka.real_person = true; d.cast.raka.consent = "privat:IZIN.md"; }), (f: string) => ((asked = f), true));
  assert(asked.endsWith("talent-privat/x/IZIN.md"), "consent privat: dicek di folder privat");
  assert(has(codes(mk((d) => { d.shots[1].angle = d.shots[0].angle; d.shots[1].scale = d.shots[0].scale; })), "W_SAME_ANGLE", "S02"), "W_SAME_ANGLE");
  assert(has(codes(mk((d) => delete d.budget_credits)), "E_BUDGET"), "E_BUDGET final");
  assert(!has(codes(mk((d) => { delete d.budget_credits; d.shots.forEach((s: any) => (s.tier = "draft")); })), "E_BUDGET"), "draft bebas E_BUDGET");
  const bad = codes(mk((d) => (d.shots[0].angle = "low-angel")));
  assert(bad.some((i) => i.code === "E_ID" && i.message.includes("low-angel")), "E_ID low-angel");
  assert(has(codes(mk((d) => (d.shots[0].start = null))), "E_FRAMES", "S01"), "E_FRAMES");
  assert(has(codes(mk((d) => (d.shots[1].join = { type: "invisible" }))), "E_INVISIBLE_AT", "S02"), "E_INVISIBLE_AT");
  assert(has(codes(mk((d) => (d.shots[0].expression = "marah"))), "E_ID", "S01"), "ekspresi tak dikenal");
  assert(has(base, "W_QUESTION", "S01"), "W_QUESTION");
  assert(has(codes(mk((d) => delete d.worlds.kafe.ambience)), "W_NO_AMBIENCE"), "W_NO_AMBIENCE");
  assert(has(codes(mk((d) => delete d.cast.raka.voice)), "W_NO_VOICE", "S01"), "W_NO_VOICE");
  assert(has(codes(mk((d) => { d.shots[0].angle = "dutch-angle"; d.shots[0].move = "dolly-in"; })), "W_DUTCH_MOVE", "S01"), "W_DUTCH_MOVE");
  assert(has(codes(mk((d) => { d.shots[0].screen_dir = "L>R"; d.shots[1].screen_dir = "R>L"; })), "W_SCREEN_DIR", "S02"), "W_SCREEN_DIR");
  assert(has(codes(mk((d) => d.shots.forEach((s: any) => (s.angle = "eye-level")))), "W_FEW_ANGLES"), "W_FEW_ANGLES");
  assert(has(codes(mk((d) => { d.cast.raka.real_person = true; d.cast.raka.consent = "privat:IZIN.md"; }), () => false), "E_CONSENT"), "consent diisi tapi berkas tak ada");
  assert(has(codes(mk((d) => { d.cast.raka.real_person = true; d.cast.raka.consent = "privat:../../x"; })), "E_CONSENT"), "consent keluar folder privat");
  let thrown = false;
  try { resolvePrivate("/tmp/x", "privat:../../x"); } catch { thrown = true; }
  assert(thrown, "resolvePrivate menolak ../");
  assert(resolvePrivate("/tmp/x", "privat:a/b.jpg").endsWith("talent-privat/x/a/b.jpg"), "resolvePrivate normal");
  {
    const saved = process.env.SINEMA_PRIVATE_ROOT;
    process.env.SINEMA_PRIVATE_ROOT = "relatif-root";
    let r = "";
    try { r = resolvePrivate("/tmp/x", "privat:a.jpg"); } catch (e) { r = `THROW ${(e as Error).message}`; }
    if (saved === undefined) delete process.env.SINEMA_PRIVATE_ROOT; else process.env.SINEMA_PRIVATE_ROOT = saved;
    assert(r === resolve("relatif-root", "talent-privat", "x", "a.jpg"), `SINEMA_PRIVATE_ROOT relatif berfungsi (${r})`);
  }
  assert(has(codes(mk((d) => (d.shots[1].id = "S01"))), "E_ID", "S01"), "id shot ganda");
  assert(!ProductionSchema.safeParse({ ...raw, shots: [{ ...raw.shots[0], angel: "x" }] }).success, "kunci salah ketik ditolak (strict)");
  assert(!ProductionSchema.safeParse({ ...raw, titel: "x" }).success, "kunci akar salah ketik ditolak");
  assert(!ProductionSchema.safeParse({ ...raw, shots: [{ ...raw.shots[0], tier: "finel" }] }).success, "tier salah ketik ditolak");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "produksi-cek-"));
  assert(loadProduction(dir) === undefined, "tanpa berkas -> undefined");
  writeFileSync(join(dir, "produksi.json"), JSON.stringify(raw));
  assert(loadProduction(dir)?.shots.length === 3, "fixture termuat");
  writeFileSync(join(dir, "produksi.json"), "{ rusak");
  let msg = "";
  try { loadProduction(dir); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes("produksi.json") && msg.includes(dir), "JSON rusak menyebut berkas+jalur");
  writeFileSync(join(dir, "produksi.json"), JSON.stringify({ ...raw, stage: "ngawur" }));
  msg = "";
  try { loadProduction(dir); } catch (e) { msg = (e as Error).message; }
  assert(msg.startsWith("produksi.json: stage:"), "skema salah menyebut jalur zod");
  // ledger qa.json + log kredit
  const { mkdtempSync: mkd2, readdirSync } = await import("node:fs");
  const qd = mkd2(join(tmpdir(), "produksi-qa-"));
  assert(Object.keys(readQa(qd)).length === 0, "readQa tanpa berkas -> kosong");
  mergeQa(qd, "S01", { keyframes: { passed: true, face: 0.9, by: "t", at: "2026-01-01" } });
  mergeQa(qd, "S02", { clips: { "a.mp4": { motion: "ok" } } });
  mergeQa(qd, "S02", { clips: { "b.mp4": { face_median: 0.7 } } });
  mergeQa(qd, "S02", { clips: { "a.mp4": { speech: "ok" } }, labels: [{ kind: "voice", verdict: "same", at: "t1" }] });
  mergeQa(qd, "S02", { labels: [{ kind: "ambience", verdict: "ok", at: "t2" }] });
  const q = readQa(qd);
  assert(q.S01?.keyframes?.passed === true && q.S02, "dua shot sama-sama ada");
  assert(q.S02.clips?.["a.mp4"]?.motion === "ok" && q.S02.clips["a.mp4"].speech === "ok" && q.S02.clips["b.mp4"]?.face_median === 0.7, "clip digabung per berkas dan per kolom");
  assert(q.S02.labels?.length === 2, "label ditambah, bukan ditimpa");
  assert(!readdirSync(qd).some((f) => f.endsWith(".tmp")), "tak ada .tmp tersisa");
  writeFileSync(join(qd, "qa.json.tmp"), "milik penulis lain");
  mergeQa(qd, "S03", { keyframes: { passed: true, by: "t", at: "y" } });
  assert(readFileSync(join(qd, "qa.json.tmp"), "utf8") === "milik penulis lain", "tmp unik per proses (tak menimpa .tmp penulis lain)");
  rmSync(join(qd, "qa.json.tmp"));
  writeFileSync(join(qd, "qa.json"), JSON.stringify({ S09: { labels: [] } }));
  mergeQa(qd, "S01", { keyframes: { passed: false, by: "t", at: "x" } });
  assert(readQa(qd).S09 && readQa(qd).S01?.keyframes?.passed === false, "gabung dengan isi disk terbaru (tulisan luar tak hilang)");
  assert(!existsSync(join(qd, "produksi.json")), "flow-mcp tak menulis produksi.json");
  writeFileSync(join(qd, "qa.json"), "{ rusak");
  let qmsg = "";
  try { readQa(qd); } catch (e) { qmsg = (e as Error).message; }
  assert(qmsg.includes("qa.json") && qmsg.includes(qd), "qa.json rusak menyebut berkas+jalur");
  const ld = mkd2(join(tmpdir(), "produksi-log-"));
  assert(spentCredits(ld) === 0 && latestClip(ld, "S01") === undefined, "log kosong");
  appendLog(ld, { t: "1", job: "a", shot: "S01", file: "a1.mp4", credits: 24 });
  appendLog(ld, { t: "2", job: "a", shot: "S01", file: "a1.mp4", credits: 24 });
  appendLog(ld, { t: "3", job: "b", shot: "S01", file: "b1.mp4", quote: 10 });
  appendLog(ld, { t: "4", job: "c", shot: "S01", credits: 99 });
  appendLog(ld, { t: "5", job: "d", shot: "S02", file: "d1.mp4", credits: 5 });
  assert(spentCredits(ld) === 24 + 10 + 5, "kredit unik per job; gagal (tanpa file) tak dihitung");
  assert(latestClip(ld, "S01") === "b1.mp4", "latestClip melewati entri tanpa file");
  assert(latestClip(ld, "S03") === undefined, "latestClip shot tanpa klip");
  appendLog(ld, { t: "6", job: "a", shot: "S01", file: "a1.mp4" });
  assert(spentCredits(ld) === 24 + 10 + 5, "entri belakangan tanpa credits/quote tak menghapus harga sebelumnya");
  appendLog(ld, { t: "7", job: "e", shot: "S03", file: "e1.mp4" });
  assert(spentCredits(ld) === 24 + 10 + 5, "job tanpa harga sama sekali = 0");
  // checkReport (flow_production check)
  const cd = mkd2(join(tmpdir(), "produksi-rep-"));
  assert((checkReport(cd, "json") as any).pipeline === false, "tanpa produksi.json -> pipeline:false");
  writeFileSync(join(cd, "produksi.json"), JSON.stringify(raw));
  appendLog(cd, { t: "1", job: "j1", shot: "S01", file: "s1.mp4", credits: 24 });
  mergeQa(cd, "S01", { keyframes: { passed: true, by: "t", at: "x" }, clips: { "s1.mp4": {} } });
  const rep = checkReport(cd, "json") as any;
  assert(rep.budget.approved === 48 && rep.budget.spent === 24 && rep.budget.remaining === 48 - 24, "budget.remaining = 48 - spent");
  assert(rep.stage === "shotlist" && Array.isArray(rep.errors) && Array.isArray(rep.warnings), "bentuk laporan");
  const r1 = rep.shots.find((x: any) => x.id === "S01");
  assert(r1.keyframes_passed === true && r1.clips.includes("s1.mp4"), "shot S01 keyframe lulus + klip");
  assert(rep.missing.includes("S02: keyframe belum lulus"), "missing: keyframe S02");
  assert(!rep.missing.includes("S01: keyframe belum lulus"), "S01 tidak missing");
  const md = (checkReport(cd, "md") as any).md as string;
  assert(md.includes("Dibangkitkan dari produksi.json") && md.includes("jangan disunting") && md.includes("S01") && md.includes("cut-on-action"), "md memuat S01 dan cut-on-action");
  writeFileSync(join(cd, "produksi.json"), JSON.stringify({ ...raw, budget_credits: undefined }));
  assert((checkReport(cd, "json") as any).missing.includes("budget_credits belum diisi"), "missing: budget");
  writeFileSync(join(cd, "produksi.json"), "{ rusak");
  const bad2 = checkReport(cd, "json") as any;
  assert(typeof bad2.error === "string" && bad2.error.includes("produksi.json") && bad2.error.includes(cd), "rusak -> error menyebut berkas");
  // Gerbang G1/G2 + anggaran G3 (tahap 1, task 4)
  const gd = mkd2(join(tmpdir(), "produksi-gate-"));
  const fin = { type: "video", tier: "final" };
  assert(gate(gd, { ...fin }).ok === true, "tanpa produksi.json -> gate ok");
  assert(gate(gd, { ...fin, shot: "S01" }).ok === true, "tanpa produksi.json -> shot diabaikan, ok");
  assert(budgetLeft(gd) === undefined, "tanpa produksi.json -> budgetLeft undefined");
  writeFileSync(join(gd, "produksi.json"), JSON.stringify(raw));
  const why = (r: ReturnType<typeof gate>) => (r.ok ? "" : r.reason);
  assert(why(gate(gd, { ...fin })).includes("wajib shot"), "video final tanpa shot -> wajib shot");
  assert(why(gate(gd, { type: "video" })).includes("wajib shot"), "video tanpa tier (model Flow saat ini) juga berbayar");
  assert(why(gate(gd, { ...fin, shot: "S09" })).includes("S09"), "shot tak dikenal ditolak");
  writeFileSync(join(gd, "produksi.json"), JSON.stringify({ ...raw, shots: raw.shots.map((x: any) => (x.id === "S01" ? { ...x, angle: "low-angel" } : x)) }));
  const g1 = why(gate(gd, { ...fin, shot: "S01" }));
  assert(g1.includes("E_ID") && g1.includes("G1"), `shot ber-error lint -> ditolak menyebut kode (${g1})`);
  assert(gate(gd, { ...fin, shot: "S03" }).ok === false && why(gate(gd, { ...fin, shot: "S03" })).includes("G2"), "error lint shot lain tak memblokir G1 S03, tapi keyframe S03 belum lulus -> G2");
  const forced = gate(gd, { ...fin, shot: "S01", force: "uji" });
  assert(forced.ok === true && forced.force === "uji", "force melewati G1/G2 dan alasan dikembalikan");
  assert(gate(gd, { ...fin, shot: "S01", force: "  " }).ok === false, "force kosong bukan force");
  writeFileSync(join(gd, "produksi.json"), JSON.stringify(raw));
  const g2 = why(gate(gd, { ...fin, shot: "S03" }));
  assert(g2.includes("keyframe") && g2.includes("S03"), `keyframe belum lulus -> ditolak (${g2})`);
  mergeQa(gd, "S03", { keyframes: { passed: false, by: "t", at: "x" } });
  assert(gate(gd, { ...fin, shot: "S03" }).ok === false, "keyframe passed:false -> ditolak");
  mergeQa(gd, "S03", { keyframes: { passed: true, by: "t", at: "x" } });
  const ok3 = gate(gd, { ...fin, shot: "S03" });
  assert(ok3.ok === true && ok3.force === undefined, "S03 lint bersih + keyframe lulus -> ok");
  assert(gate(gd, { type: "video", tier: "draft" }).ok === true, "draft bebas gerbang (tanpa shot/keyframe)");
  assert(gate(gd, { type: "image" }).ok === true, "gambar bebas gerbang");
  // anggaran: budget 48, terpakai 24, quote 30 -> sisa 24 -> tolak
  assert(budgetLeft(gd) === 48, "budget penuh tanpa log");
  appendLog(gd, { t: "1", job: "j1", shot: "S03", file: "s3.mp4", quote: 24, credits: 24 });
  assert(budgetLeft(gd) === 24, "budgetLeft = 48 - 24");
  assert(overBudget(24, 30) === true, "quote 30 > sisa 24 -> tolak");
  assert(overBudget(24, 24) === false, "quote = sisa -> boleh");
  assert(overBudget(-5, 0) === false, "quote 0 (draft) tak pernah ditolak");
  writeFileSync(join(gd, "produksi.json"), JSON.stringify({ ...raw, budget_credits: undefined }));
  assert(budgetLeft(gd) === -24, "budget belum diisi -> sisa 0 - terpakai (tak bisa di-force)");
  // produksi.json rusak -> semua job project itu ditolak dengan pesan berkas + jalur
  writeFileSync(join(gd, "produksi.json"), "{ rusak");
  for (const sc of [{ ...fin, shot: "S03", force: "x" }, { type: "image" }, { type: "video", tier: "draft" }]) {
    const r = why(gate(gd, sc));
    assert(r.includes("produksi.json") && r.includes(gd), `rusak -> ditolak menyebut berkas+jalur (${JSON.stringify(sc)})`);
  }
  writeFileSync(join(gd, "produksi.json"), JSON.stringify({ ...raw, stage: "ngawur" }));
  const r2 = why(gate(gd, { type: "image" }));
  assert(r2.includes("stage") && r2.includes(join(gd, "produksi.json")), `skema salah -> jalur zod + berkas (${r2})`);
  let threw = "";
  try { budgetLeft(gd); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes(join(gd, "produksi.json")), "budgetLeft pada berkas rusak melempar dengan jalur");
  // G3 sebagai fungsi murni (dipakai flow.ts di titik quote)
  const g3d = mkd2(join(tmpdir(), "produksi-g3-"));
  assert(g3Check(g3d, 999, { type: "video" }).ok === true, "G3 tanpa produksi.json -> ok");
  writeFileSync(join(g3d, "produksi.json"), JSON.stringify(raw));
  appendLog(g3d, { t: "1", job: "j1", file: "a.mp4", credits: 24 });
  const g3 = g3Check(g3d, 30, { type: "video" });
  assert(!g3.ok && g3.reason.includes("sisa 24") && g3.reason.includes("quote 30") && g3.reason.includes("budget_credits"), "G3 48-24 < 30 -> tolak");
  assert(g3Check(g3d, 24, { type: "video" }).ok === true, "G3 quote = sisa -> ok");
  assert(g3Check(g3d, 0, { type: "video" }).ok === true, "G3 quote 0 (draft) -> ok");
  assert(g3Check(g3d, 30, { type: "image" }).ok === true, "G3 tidak berlaku untuk gambar");
  writeFileSync(join(g3d, "produksi.json"), "{ rusak");
  const g3b = g3Check(g3d, 1, { type: "video" });
  assert(!g3b.ok && g3b.reason.includes(join(g3d, "produksi.json")), "G3 berkas rusak -> tolak menyebut jalur");
  // alat tanpa quote: anggaran dibebani perkiraan; selisih saldo hanya informasi (measured)
  const md2 = mkd2(join(tmpdir(), "produksi-measured-"));
  appendLog(md2, { t: "1", job: "e1", file: "edit-01.mp4", quote: 20, credits: 20, estimate: true, measured: -500 });
  appendLog(md2, { t: "2", job: "e2", file: "edit-02.mp4", quote: 20, credits: 20, estimate: true, measured: 1380 });
  assert(spentCredits(md2) === 40, "measured (-500 / +1380) diabaikan; anggaran = perkiraan");
  const md3 = mkd2(join(tmpdir(), "produksi-measured-"));
  appendLog(md3, { t: "1", job: "e1", file: "edit-01.mp4", quote: 20, credits: 20, estimate: true, measured: -500 });
  appendLog(md3, { t: "1", job: "e1", file: "edit-01.mp4", quote: 20, credits: 20, estimate: true, measured: 1380 });
  assert(spentCredits(md3) === 20, "estimate 20, measured -500 dan +1380 -> spent 20");
  // alat tanpa quote
  assert(estimateCost("continue") === 24, "Extend/continue = harga klip Omni 1.2 (24)");
  assert(estimateCost("edit") === 50, "edit tanpa durasi diketahui = 5 x 10 dtk (terpanjang)");
  assert(estimateCost("edit", 4) === 20, "edit 4 dtk = 20");
  assert(estimateCost("edit", 4.2) === 25, "durasi dibulatkan ke atas");

  // ---- rujukan frame turunan: shot:S01@1.0 / crop:1.10 (ffmpeg sungguhan, faceScore palsu diinjeksi) ----
  {
    const { execFileSync } = await import("node:child_process");
    const fd = mkd2(join(tmpdir(), "produksi-frame-"));
    writeFileSync(join(fd, "produksi.json"), JSON.stringify(raw));
    execFileSync("nice", ["-n", "10", process.env.FLOW_MCP_FFMPEG ?? "ffmpeg", "-v", "error", "-threads", "4", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=24", "-pix_fmt", "yuv420p", join(fd, "scene-01.mp4")]);
    appendLog(fd, { t: "1", job: "j1", shot: "S01", file: "scene-01.mp4", credits: 0 });
    const dims = (f: string) => String(execFileSync(process.env.FLOW_MCP_FFPROBE ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", f])).trim();
    const errOf = async (f: () => Promise<unknown> | unknown) => { try { await f(); return ""; } catch (e) { return (e as Error).message; } };
    let seenRefs: string[] = [];
    const byIndex = (best: number, hi = 0.91, lo = 0.5) => async (img: string, refs: string[]) => {
      seenRefs = refs;
      return Number(basename(img).match(/k-(\d+)/)?.[1]) === best ? hi : lo;
    };
    setFaceScorer(byIndex(7));
    const r1 = await resolveFrameRef(fd, "shot:S01@1.0");
    assert(r1.face === 0.91 && basename(r1.path).includes("1.10s") && existsSync(r1.path), `shot:S01@1.0 memilih skor tertinggi (frame ke-7 = 1,10 dtk): ${r1.path} ${r1.face}`);
    assert(dirname(r1.path) === join(fd, "frame", "turunan"), "frame turunan ditulis di <project>/frame/turunan");
    assert(readdirSync(join(fd, "frame", "turunan")).every((f) => !f.startsWith("kandidat")), "kandidat dibersihkan");
    assert(seenRefs.length === 1 && seenRefs[0] === join(fd, "talent/ekspresi/curiga.png"), `ref wajah = face_refs[expression] pemeran shot (${seenRefs})`);
    setFaceScorer(byIndex(1));
    const r2 = await resolveFrameRef(fd, "shot:S01");
    assert(basename(r2.path).includes("2.50s"), `shot:S01 tanpa @ = 0,5 dtk terakhir (${r2.path})`);
    setFaceScorer(async () => 0.7);
    const e1 = await errOf(() => resolveFrameRef(fd, "shot:S01@1.0"));
    assert(e1.includes("cut-on-action") && e1.includes("0.70"), `semua < 0,80 -> saran cut-on-action (${e1})`);
    setFaceScorer(async () => null);
    const e1b = await errOf(() => resolveFrameRef(fd, "shot:S01@1.0"));
    assert(e1b.includes("cut-on-action") && e1b.includes("tidak terdeteksi"), `wajah tak terdeteksi = tidak lulus (${e1b})`);
    setFaceScorer(async () => { throw new Error("SINEMA_SCRIPTS belum diatur"); });
    const e1c = await errOf(() => resolveFrameRef(fd, "shot:S01@1.0"));
    assert(e1c.includes("SINEMA_SCRIPTS belum diatur") && e1c.includes("cut-on-action"), `cek wajah gagal = tidak lulus, alasan disebut (${e1c})`);
    const e2 = await errOf(() => resolveFrameRef(fd, "shot:S09@1.0"));
    assert(e2.includes("S09 belum punya klip; jalankan setelah klip induk dipilih"), `S09 tanpa klip (${e2})`);
    const e3 = await errOf(() => checkFrameRefs(fd, { first_frame: "shot:S02@4.2", last_frame: "crop:1.10", shot: "S03" }));
    assert(e3.includes("S02 belum punya klip; jalankan setelah klip induk dipilih"), `checkFrameRefs S02 tanpa klip (${e3})`);
    const e4 = await errOf(() => resolveFrameRef(fd, "shot:S01@9"));
    assert(e4.includes("durasi"), `@ di luar durasi klip (${e4})`);
    // chosen menang atas log; chosen hilang -> pesan jelas
    writeFileSync(join(fd, "produksi.json"), JSON.stringify({ ...raw, shots: raw.shots.map((x: any) => (x.id === "S01" ? { ...x, chosen: "hilang.mp4" } : x)) }));
    const e5 = await errOf(() => resolveFrameRef(fd, "shot:S01@1.0"));
    assert(e5.includes("hilang.mp4"), `chosen tak ada di disk (${e5})`);
    writeFileSync(join(fd, "produksi.json"), JSON.stringify(raw));
    // crop
    setFaceScorer(byIndex(7));
    const c1 = await resolveFrameRef(fd, "crop:1.10", undefined, { source: r1.path });
    assert(existsSync(c1.path) && dims(c1.path) === dims(r1.path) && dims(c1.path) === "320x240", `crop:1.10 ukuran = sumber (${dims(c1.path)})`);
    assert(dirname(c1.path) === join(fd, "frame", "turunan") && c1.path.endsWith(".png"), "crop ditulis di frame/turunan sebagai png");
    const c2 = await resolveFrameRef(fd, "crop:1.5", undefined, { source: r1.path, center: [1, 1] });
    assert(dims(c2.path) === "320x240", "crop_center di tepi: kotak dijepit di dalam gambar, ukuran tetap");
    assert((await errOf(() => resolveFrameRef(fd, "crop:0.9", undefined, { source: r1.path }))).includes("crop"), "crop < 1 ditolak");
    // satu scene: START dari shot, END crop -> pasangan turunan lulus otomatis
    const sp: { first_frame?: string; last_frame?: string; shot?: string; crop_center?: [number, number] } = { first_frame: "shot:S01@1.0", last_frame: "crop:1.10", shot: "S02" };
    checkFrameRefs(fd, sp);
    const notes = await resolveSceneFrames(fd, sp, { tag: "jobA" });
    assert(basename(sp.first_frame!).includes("-jobA") && basename(sp.last_frame!).includes("-jobA"), `nama berkas turunan memuat id job (${sp.first_frame}, ${sp.last_frame})`);
    assert(existsSync(sp.first_frame!) && existsSync(sp.last_frame!) && sp.last_frame!.endsWith(".png"), "kedua frame jadi berkas lokal");
    assert(seenRefs[0] === join(fd, "talent/ekspresi/senyum.png"), "ref wajah dari shot TUJUAN (S02 smile)");
    const kq = readQa(fd).S02?.keyframes;
    assert(kq?.passed === true && kq.by === "turunan" && kq.face === 0.91, `qa.json S02 keyframes turunan (${JSON.stringify(kq)})`);
    assert(notes.some((n) => n.includes("turunan")), "catatan job menyebut frame turunan");
    const fa: { first_frame?: string; first_frame_at?: number } = { first_frame: "shot:S01", first_frame_at: 1.0 };
    setFaceScorer(byIndex(7));
    await resolveSceneFrames(fd, fa);
    assert(basename(fa.first_frame!).includes("1.10s"), `first_frame_at = titik @ untuk shot: (${fa.first_frame})`);
    // pull-back: START = crop dari END
    setFaceScorer(byIndex(1));
    const pb: { first_frame?: string; last_frame?: string; shot?: string } = { first_frame: "crop:1.2", last_frame: "shot:S01", shot: "S02" };
    await resolveSceneFrames(fd, pb);
    assert(pb.first_frame!.endsWith(".png") && dims(pb.first_frame!) === "320x240", "pull-back: START = crop dari END");
    // tanpa face_refs di shot TUJUAN: pasangan turunan melempar (tanpa cadangan ref shot sumber), scene tak diubah sebagian
    writeFileSync(join(fd, "produksi.json"), JSON.stringify({ ...raw, shots: raw.shots.map((x: any) => (x.id === "S02" ? { ...x, expression: undefined } : x)) }));
    const np: { first_frame?: string; last_frame?: string; shot?: string } = { first_frame: "shot:S01@1.0", last_frame: "crop:1.10", shot: "S02" };
    const e7 = await errOf(() => resolveSceneFrames(fd, np));
    assert(e7.includes("face_refs") && np.first_frame === "shot:S01@1.0" && np.last_frame === "crop:1.10", `tujuan tanpa face_refs -> gagal, scene utuh (${e7})`);
    const npx = { ...np };
    await resolveSceneFrames(fd, npx, { exempt: true });
    assert(existsSync(npx.first_frame!), "force/draft (exempt): frame tetap diselesaikan tanpa lulus");
    writeFileSync(join(fd, "produksi.json"), JSON.stringify(raw));
    // sisi pertama selesai, sisi kedua gagal (di luar durasi) -> sisi pertama juga tidak diubah
    const half: { first_frame?: string; last_frame?: string; shot?: string } = { first_frame: "shot:S01@1.0", last_frame: "shot:S01@9", shot: "S02" };
    const e8 = await errOf(() => resolveSceneFrames(fd, half));
    assert(e8.includes("durasi") && half.first_frame === "shot:S01@1.0", `kegagalan satu sisi tak meninggalkan mutasi sebagian (${e8})`);
    // validasi
    assert((await errOf(() => checkFrameRefs(fd, { first_frame: "crop:1.1", last_frame: "crop:1.2" }))).includes("crop"), "dua crop ditolak");
    assert((await errOf(() => checkFrameRefs(fd, { last_frame: "crop:1.1" }))).includes("crop"), "crop tanpa frame lawan ditolak");
    assert((await errOf(() => checkFrameRefs(fd, { first_frame: "asset:x", last_frame: "crop:1.1" }))).includes("asset:"), "crop dari asset: ditolak");
    assert((await errOf(() => checkFrameRefs(fd, { first_frame: "shot:S01@x" }))).includes("shot:"), "sintaks shot: salah ditolak");
    checkFrameRefs(fd, { first_frame: "/a/b.png", last_frame: "asset:y" });
    const nd = mkd2(join(tmpdir(), "produksi-frame-nop-"));
    const e6 = await errOf(() => checkFrameRefs(nd, { first_frame: "shot:S01@1.0" }));
    assert(e6.includes("produksi.json"), `tanpa produksi.json -> shot:/crop: ditolak jelas (${e6})`);
    checkFrameRefs(nd, { first_frame: "/a/b.mp4", last_frame: "/c.png" });
    // gerbang: pasangan turunan (shot: + crop:) menunda G2 ke saat job jalan; frame biasa tetap G2
    rmSync(join(fd, "qa.json"));
    const gt = gate(fd, { type: "video", tier: "final", shot: "S02", first_frame: "shot:S01@1.0", last_frame: "crop:1.10" });
    assert(gt.ok && gt.derived === true, `pasangan turunan: G2 ditunda (${JSON.stringify(gt)})`);
    const gp = gate(fd, { type: "video", tier: "final", shot: "S02", first_frame: "/a.png", last_frame: "crop:1.10" });
    assert(!gp.ok && gp.reason.includes("G2"), "crop dari frame biasa: G2 tetap");
    setFaceScorer(undefined);
    rmSync(fd, { recursive: true, force: true });
    rmSync(nd, { recursive: true, force: true });
  }
  console.log("produksi ok");
}
