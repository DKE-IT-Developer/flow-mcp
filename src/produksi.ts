// produksi.json: schema + lint (tahap 1). Opt-in: a project without the file behaves as before.
// Self-check: `node dist/produksi.js --cek`
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    throw new Error(`produksi.json: ${i.path.join(".") || "(akar)"}: ${i.message}`);
  }
  return r.data;
}

// Same default as OUTPUT_ROOT in core.ts, recomputed here so this module stays free of the heavy core imports.
const outputRoot = () => process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
const privateRoot = () => process.env.SINEMA_PRIVATE_ROOT ?? dirname(resolve(outputRoot()));

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
  const tmp = `${f}.tmp`;
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
  for (const e of readLog(projectDir)) if (e.file) byJob.set(e.job, e.credits ?? e.quote ?? 0);
  let sum = 0;
  for (const v of byJob.values()) sum += v;
  return sum;
}

/** Berkas terbaru (urutan berkas log) untuk shot itu yang punya `file`. */
export function latestClip(projectDir: string, shot: string): string | undefined {
  const l = readLog(projectDir).filter((e) => e.shot === shot && e.file);
  return l.length ? l[l.length - 1].file : undefined;
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
  console.log("produksi ok");
}
