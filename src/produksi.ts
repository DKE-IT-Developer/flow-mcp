// produksi.json: schema + lint (tahap 1). Opt-in: a project without the file behaves as before.
// Self-check: `node dist/produksi.js --cek`
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
export type LogEntry = { t: string; job: string; shot?: string; file?: string; tier?: string; quote?: number; credits?: number; estimate?: boolean; force?: string };

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

/** Kredit terpakai: hanya entri ber-file (job selesai), sekali per job id (retry tak menggandakan). */
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

export type GateScene = { shot?: string; force?: string; tier?: string; type: string; model?: string };
export type GateResult = { ok: true; force?: string } | { ok: false; reason: string };

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
    const r = why(gate(sc.type === "image" ? gd : gd, sc));
    assert(r.includes("produksi.json") && r.includes(gd), `rusak -> ditolak menyebut berkas+jalur (${JSON.stringify(sc)})`);
  }
  writeFileSync(join(gd, "produksi.json"), JSON.stringify({ ...raw, stage: "ngawur" }));
  const r2 = why(gate(gd, { type: "image" }));
  assert(r2.includes("stage") && r2.includes(join(gd, "produksi.json")), `skema salah -> jalur zod + berkas (${r2})`);
  let threw = "";
  try { budgetLeft(gd); } catch (e) { threw = (e as Error).message; }
  assert(threw.includes(join(gd, "produksi.json")), "budgetLeft pada berkas rusak melempar dengan jalur");
  // alat tanpa quote
  assert(estimateCost("continue") === 24, "Extend/continue = harga klip Omni 1.2 (24)");
  assert(estimateCost("edit") === 50, "edit tanpa durasi diketahui = 5 x 10 dtk (terpanjang)");
  assert(estimateCost("edit", 4) === 20, "edit 4 dtk = 20");
  assert(estimateCost("edit", 4.2) === 25, "durasi dibulatkan ke atas");
  console.log("produksi ok");
}
