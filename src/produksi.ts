// produksi.json: schema + lint (tahap 1). Opt-in: a project without the file behaves as before.
// Self-check: `node dist/produksi.js --cek`
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { techniqueById } from "./techniques.js";

export const SCALES = ["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"] as const;
export const JOIN_TYPES = ["cut", "cut-on-action", "match-cut", "invisible", "push-through", "rack-focus", "whip", "dissolve", "dip"] as const;
export const STAGES = ["mulai", "konsep", "kunci", "naskah", "shotlist", "keyframe", "uji", "generate", "qa", "suara", "rakit", "serah"] as const;

const Beat = z.object({
  at: z.tuple([z.number(), z.number()]),
  action: z.string(),
  says: z.string().nullish(),
});
const Cast = z.object({
  identity: z.string(),
  voice: z.string().optional(),
  real_person: z.boolean().default(false),
  consent: z.string().nullish(),
  photos: z.array(z.string()).optional(),
  face_refs: z.record(z.string(), z.string()).default({}),
  voice_ref: z.string().nullish(),
  wardrobe: z.record(z.string(), z.string()).default({}),
});
const Prop = z.object({
  description: z.string(),
  refs: z.array(z.string()).default([]),
  invariant: z.string().optional(),
});
const World = z.object({
  location: z.string(),
  light: z.string(),
  ambience: z.string().optional(),
});
const Shot = z.object({
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
  sfx: z.array(z.object({ at: z.number(), sound: z.string() })).default([]),
  start: z.string().nullish(),
  end: z.string().nullish(),
  join: z.object({ type: z.enum(JOIN_TYPES), at_prev: z.number().optional(), audio: z.enum(["j", "l"]).optional() }).optional(),
  tier: z.string().default("final"),
  chosen: z.string().nullish(),
  range: z.unknown().optional(),
});

export const ProductionSchema = z.object({
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
  decisions: z.array(z.object({ date: z.string(), stage: z.string(), text: z.string() })).default([]),
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
  if (ref.startsWith("privat:")) return join(privateRoot(), "talent-privat", basename(resolve(projectDir)), ref.slice(7));
  return resolve(projectDir, ref);
}

const wordCount = (s: string) => s.replace(/[^\p{L}\p{N}\s'-]+/gu, " ").split(/\s+/).filter(Boolean).length;
const hasRef = (v: string | null | undefined) => !!v && v.trim() !== "";

export function lint(p: Production, exists: (path: string) => boolean, projectDir = "."): Issue[] {
  const out: Issue[] = [];
  const add = (level: Issue["level"], code: string, message: string, shot?: string) => out.push({ level, code, message, ...(shot ? { shot } : {}) });
  const err = (code: string, message: string, shot?: string) => add("error", code, message, shot);
  const warn = (code: string, message: string, shot?: string) => add("warning", code, message, shot);

  for (const [name, c] of Object.entries(p.cast)) {
    if (!c.real_person) continue;
    if (!hasRef(c.consent) || !exists(resolvePrivate(projectDir, c.consent!))) err("E_CONSENT", `pemeran '${name}' real_person tanpa berkas consent yang ada`);
    for (const ph of c.photos ?? []) if (!ph.startsWith("privat:")) err("E_PHOTOS_PUBLIC", `pemeran '${name}': foto asli '${ph}' harus berawalan privat:`);
  }
  for (const [name, w] of Object.entries(p.worlds)) if (!hasRef(w.ambience)) warn("W_NO_AMBIENCE", `dunia '${name}' tanpa ambience`);

  let prev: Production["shots"][number] | undefined;
  for (const s of p.shots) {
    const id = s.id;
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
  const codes = (p: Production, ex = yes) => lint(p, ex, "/tmp/x");
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
  const { mkdtempSync, writeFileSync } = await import("node:fs");
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
  console.log("produksi ok");
}
