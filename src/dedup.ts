// Local patch (14 Nov 2026, ai-video workspace): stop re-uploading and re-generating what the Flow project already has.
// Measured before the patch: 46 of 124 uploads were byte-identical files uploaded again, so the Flow grid filled with
// look-alike images. Two small ledgers in FLOW_MCP_HOME remember what each project already holds.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { HOME_DIR } from "./chrome.js";

const UPLOADS = join(HOME_DIR, "uploads.json");
const IMAGES = join(HOME_DIR, "images.json");

const load = <T>(f: string): Record<string, T> => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
};
const save = <T>(f: string, key: string, value: T | undefined) => {
  const l = load<T>(f);
  if (value === undefined) delete l[key];
  else l[key] = value;
  writeFileSync(f, JSON.stringify(l, null, 1));
};

export const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const uploadKey = (project: string, file: string) => `${basename(project)}|${fileHash(file)}`;

// Flow asset names worth trying before an upload: what this exact file was uploaded as earlier in the project, and,
// for a file flow-mcp downloaded itself (<project>/scene-NN.jpeg), the tile it came from (renamed "<project>-scene-NN").
export function knownAssetNames(project: string, file: string): string[] {
  const names: string[] = [];
  const earlier = load<string>(UPLOADS)[uploadKey(project, file)];
  if (earlier) names.push(earlier);
  const stem = basename(file, extname(file));
  if (resolve(dirname(file)) === resolve(project) && /^scene-\d+(-v\d+)?$/.test(stem)) names.push(`${basename(project)}-${stem}`);
  return [...new Set(names)];
}
export const rememberUpload = (project: string, file: string, name: string) => save(UPLOADS, uploadKey(project, file), name);
export const forgetUpload = (project: string, file: string) => save<string>(UPLOADS, uploadKey(project, file), undefined);

// An image request is "the same" when project, final prompt, model, ratio, variants and the references (by content)
// all match. Unknown/unhashable references make the key undefined: then it is always generated.
export function imageKey(p: { output_dir: string; prompt: string; model?: string; aspect_ratio?: string; variants?: number; reference_images?: string[] }): string | undefined {
  const refs: string[] = [];
  for (const r of p.reference_images ?? []) {
    if (r.startsWith("asset:")) refs.push(r);
    else if (existsSync(r)) refs.push(fileHash(r));
    else return undefined;
  }
  const body = JSON.stringify([basename(p.output_dir), p.prompt.trim(), p.model ?? "", p.aspect_ratio ?? "", p.variants ?? 1, refs]);
  return createHash("sha256").update(body).digest("hex");
}
// Earlier result for this key, only while every file still exists (deleted output = generate again).
export function earlierImages(key: string): string[] | undefined {
  const files = load<string[]>(IMAGES)[key];
  return files?.length && files.every((f) => existsSync(f)) ? files : undefined;
}
export const rememberImages = (key: string, files: string[]) => save(IMAGES, key, files);

// ponytail: self-check without a test framework — `node dist/dedup.js --cek`
if (process.argv[1]?.endsWith("dedup.js") && process.argv.includes("--cek")) {
  const { mkdtempSync, writeFileSync: w } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const proj = mkdtempSync(join(tmpdir(), "dedup-cek-"));
  const a = join(proj, "a.png");
  w(a, "x");
  const own = join(proj, "scene-07.jpeg");
  w(own, "y");
  const k1 = imageKey({ output_dir: proj, prompt: "p", reference_images: [a] });
  w(join(proj, "b.png"), "x"); // same bytes, other name -> same key
  const k2 = imageKey({ output_dir: proj, prompt: "p ", reference_images: [join(proj, "b.png")] });
  if (k1 !== k2) throw new Error("same content should give the same key");
  if (imageKey({ output_dir: proj, prompt: "p", reference_images: [join(proj, "nope.png")] }) !== undefined) throw new Error("missing ref must disable dedup");
  if (!knownAssetNames(proj, own).includes(`${basename(proj)}-scene-07`)) throw new Error("own download should map to its tile");
  if (knownAssetNames(proj, a).length) throw new Error("unknown file has no name");
  console.log("dedup ok");
}
