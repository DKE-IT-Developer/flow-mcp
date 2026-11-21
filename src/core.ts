import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assemble, voiceTrack } from "./assemble.js";
import { GEMINI_VOICES, geminiKey, saveGeminiKey, speakWithGemini } from "./gemini.js";
import { KOKORO_DEFAULT_VOICE, KOKORO_MB, KOKORO_VOICES, kokoroReady, speakWithKokoro } from "./kokoro.js";
import { extractFirstFrame, extractFrameAt, extractLastFrame } from "./chain.js";
import { burnCaptions, captionedName, captionSetup, previewCaptions, transcribe } from "./captions.js";
import { presenter } from "./presenter.js";
import { appendLog, budgetLeft, budgetMessage, checkFrameRefs, checkReport, estimateCost, gate, isDerivedRef, loadProduction, MEASURED_NOTE, overBudget, paidVideo, resolveSceneFrames } from "./produksi.js";
import { characterLook, createCharacter, createProject, downloadAsset, trashAsset, editCharacter, getFlowState, listAssets, forgetCharacter, listCharacters, rememberCharacter, runAgentBatch, runContinue, runEdit, runGeneration } from "./flow.js";
import { JobQueue, type Job, type SceneParams } from "./queue.js";
import { earlierImages, imageKey, rememberImages } from "./dedup.js";
import { BIN, COMPUTER, moveToBin } from "./platform.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";

export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
const words = (s: string) => s.split(/[^a-z0-9]+/i).filter((w) => w.length > 3).map((w) => w.toLowerCase());

export const projectDir = (project: string) => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));

const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z
    .string()
    .optional()
    .describe("Model label as shown in Flow, e.g. 'Omni 1.1 Flash', 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana Pro'. Images default to the newest Nano Banana (2.1 today); video omitted keeps Flow's current model."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).optional().describe("Video length in seconds. Omni models only; Veo 3.1 clips are fixed at 8s."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z.number().int().min(0).default(25).describe("Safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: z
    .string()
    .optional()
    .describe("First frame: absolute image path, 'asset:<title>' for an image already in the Flow project, or the absolute path of a finished clip (.mp4) to start exactly on its last frame - chain_previous across separate calls."),
  first_frame_at: z
    .number()
    .min(0)
    .optional()
    .describe("When first_frame is a clip: start from the frame at this second instead of its last frame, e.g. right where the speech ends, so dead time at the end of a take is skipped. Cut that clip at the same second in flow_assemble's `trims` and the join stays invisible."),
  last_frame: z
    .string()
    .optional()
    .describe("Last frame: absolute image path, 'asset:<title>', or the absolute path of a finished clip (.mp4) to end exactly where that clip begins. With first_frame set to the clip before, this redoes a middle clip and keeps both cuts invisible. Projects with a produksi.json also take 'crop:1.10' (the resolved first frame enlarged 1.10x, same size; see crop_center) or 'shot:S02@4.2'."),
  crop_center: z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
    .optional()
    .describe("Projects with a produksi.json only: centre [x, y] (0..1, default [0.5, 0.5]) of a 'crop:' frame; the crop box stays inside the image."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe(
      "Reference media: absolute image paths, or 'asset:<title>' for media or characters already in the Flow project. Flow's COMPOSER takes references OR first/last frames on a video scene, never both, so with frames set these are skipped and the job says so. Flow itself can do both via agent mode (save the last frame, Animate it, then add the character).",
    ),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image (free, slower). Default original."),
  retries: z.number().int().min(0).max(3).default(1).describe("Automatic retries when Flow itself reports the generation failed."),
  technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  angle: z.string().optional().describe("Camera angle id from flow_techniques category 'angle' (e.g. 'low-angle', 'over-the-shoulder'); its phrase OPENS the prompt, where the model weighs it most. One per scene; combine with a camera-move technique, and vary angles across scenes."),
  on_screen_text: z
    .boolean()
    .optional()
    .describe("Video only: true when words SHOULD appear in the picture (a sign, a title card). By default every video prompt forbids subtitles and on-screen text, because Omni otherwise burns in its own garbled captions."),
  outfit: z
    .string()
    .max(300)
    .optional()
    .describe("What a referenced character wears in this scene when it differs from their saved look, e.g. 'a plain cream crewneck sweatshirt'. The character lock then keeps face, hair and build but takes the clothes from here."),
  reference_previous: z
    .boolean()
    .optional()
    .describe("Use the previous scene's finished image as an extra reference, so this scene inherits its exact drawing of the characters, style and palette. Best way to keep a set of stills on-model."),
  tier: z
    .enum(["draft", "final", "hero"])
    .optional()
    .describe("Video model by purpose, when `model` is not given. draft = free (Veo 3.1 Lite [Lower Priority], 0 credits): checks framing, camera and motion; if its acting is right, USE the draft clip, it is full quality. final = Omni 1.2 Flash (~24), which follows written acting beats most closely. hero = two Omni takes to pick from (~48, raise max_credits) for close-ups where face, expression or hands carry the shot. The most expensive model (Veo 3.1 - Quality, 100) acted no more naturally than the free one in a side-by-side test."),
  performance: z
    .boolean()
    .optional()
    .describe("Video with people gets a PERFORMANCE block (real-time speed, weight, eyes-first expressions, blinks, breathing, still hands, real skin) appended automatically. false = leave it out."),
  regenerate: z
    .boolean()
    .optional()
    .describe("Images: make a NEW take even when this project already has an image from the exact same prompt, model, ratio and references. Without it such a request returns the earlier image and nothing is sent to Flow (no duplicate tiles)."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
  shot: z
    .string()
    .min(1)
    .optional()
    .describe("Projects with a produksi.json only: the shot id this scene makes (e.g. 'S03'). Every paid video there needs one, a lint-clean shot and passed START/END keyframes in qa.json; the clip is logged against the shot's credit budget. Ignored elsewhere."),
  force: z
    .string()
    .optional()
    .describe("Projects with a produksi.json only: a reason (e.g. 'uji sudut kamera') to skip the lint and keyframe gates for this scene. It is logged and returned on the job. The credit budget can never be forced: raise budget_credits in produksi.json after the user agrees."),
});
export type Scene = z.infer<typeof sceneSchema>;

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
const captionFields = {
  video: z.string().min(1).describe("Absolute path of the video to caption: any MP4 or MOV on this computer, such as a film made with flow_assemble."),
  style: z
    .enum(["bold", "highlight", "reveal", "clean", "boxed"])
    .default("bold")
    .describe(
      "bold: big capitals, 1-3 words at a time, the spoken word lights up (the short-form look). highlight: the spoken word sits on a coloured block. reveal: words appear as they are said. clean: classic subtitles. boxed: white words on a dark band.",
    ),
  position: z
    .union([z.enum(["bottom", "middle", "top"]), z.number().min(0).max(100)])
    .default("bottom")
    .describe("bottom, middle or top - or a number for an exact height: how far down the frame the middle of the caption sits, 0 = top edge, 100 = bottom edge."),
  size: z
    .union([z.enum(["small", "medium", "large"]), z.number().min(40).max(250)])
    .default("medium")
    .describe("small, medium, large, or a percentage of the style's normal size (100 = medium, 150 = half again as big)."),
  lead: z
    .number()
    .min(-0.5)
    .max(0.5)
    .optional()
    .describe("Seconds the highlight runs ahead of the voice. Default 0.12; raise it if words still light up late, lower it if early."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Highlight colour as #RRGGBB, for bold, highlight and reveal."),
  letters: z
    .enum(["as_said", "capitals", "lowercase"])
    .optional()
    .describe("as_said keeps normal capitals (sentence starts, names); capitals is the high-energy short-form look; lowercase is the calm, casual look, and names still keep their capital in it. Default: capitals for bold, as_said for the rest."),
  names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Lowercase only: names to keep capitalised even where they start a sentence (e.g. [\"Juno\"]). Names in the middle of a sentence are found by themselves."),
  text: z.string().max(50_000).optional().describe("Corrected words, to fix anything misheard. Timings are kept for every word that still matches; a line break starts a new caption."),
  words: z
    .array(z.object({ text: z.string().min(1), start: z.number().min(0), end: z.number().min(0) }))
    .max(5000)
    .optional()
    .describe("Word timings to use instead of hearing the whole video, e.g. from flow_transcribe on each clip of a joined film, shifted by where each clip starts in it. Use it when the film's own sound (music, a train, crowd) throws the timing off. text still corrects the words on top."),
  language: z
    .string()
    .default("auto")
    .describe(
      "Spoken language as a code: en, es, fr, de, pt, tr, ja, zh, ar... Pass it whenever you know it. auto detects it (a 60 MB detector downloads once). English uses a 148 MB model; every other language a 574 MB one, each downloaded the first time.",
    ),
};

export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips the plan/credits readout, which briefly opens Flow's account panel.") },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
    scenes: z.array(sceneSchema).min(1).max(100),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids from a queued call, or the task_id of a call that answered still_working. Default: every queued job."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("An MCP call returns after at most 40 s whatever this says, so call again until finished is true."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs to re-queue. Default: every failed job.") },
  assets: { kind: z.enum(["image", "video", "scene"]).optional() },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z.array(z.string().min(1)).min(1).max(30).describe("Titles (or title prefixes) from flow_assets, in the order they should be numbered."),
    quality: z.enum(["original", "upscaled"]).default("original"),
  },
  production: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    action: z.enum(["check"]).describe("check: free report on the project's produksi.json (lint, budget, per-shot QA, what the next stage still lacks)."),
    format: z.enum(["json", "md"]).default("json").describe("md returns a storyboard summary table generated from produksi.json."),
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    end_hold: z.object({ seconds: z.number().min(0).max(10), fade: z.number().min(0).max(10).optional() }).optional().describe("Hold the last frame this many seconds at the end, fading to black over its last `fade` seconds."),
    music_curve: z.array(z.object({ at: z.number().min(0), volume: z.number().min(0).max(2) })).optional().describe("Music level over the film on top of music_volume: {at: seconds, volume}, straight lines between points. Fade in, drop for a quiet moment, rise for the ending."),
    duck_music: z.boolean().optional().describe("Pull the music down automatically while the voiceover speaks, and let it back up in the gaps."),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    voice_lines: z
      .array(
        z.object({
          file: z.string().min(1).describe("Take to cut the line from: audio or video (its sound is used)."),
          from: z.number().min(0).optional().describe("Start of the line within the take, seconds (from flow_transcribe word times)."),
          to: z.number().min(0).optional().describe("End of the line within the take, seconds."),
          at: z.number().min(0).describe("Where the line starts in the film, seconds."),
          max_seconds: z.number().min(0.2).optional().describe("Longest it may last; a longer line is sped up slightly (at most 1.25x)."),
        }),
      )
      .max(60)
      .optional()
      .describe(
        "A timed voiceover built from separate lines, each placed at its own moment in the film - for example lines cut from several Flow takes in your avatar's voice, each landing on the title it describes. Replaces `voiceover`.",
      ),
    output_name: z.string().default("final"),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
    trims: z
      .array(
        z
          .object({
            from: z.number().min(0).optional(),
            to: z.number().min(0).optional(),
            volume: z.number().min(0).max(2).optional().describe("This clip's own sound level, 1 = as made. Lower a take whose background noise is louder than the clip before it, so the room does not jump at the cut."),
            fade_in: z.number().min(0).max(2).optional().describe("Seconds to fade this clip's sound in (trimmed edges always get 0.015 s so a cut never clicks)."),
            fade_out: z.number().min(0).max(2).optional().describe("Seconds to fade this clip's sound out."),
            soften_in: z.number().min(0).max(3).optional().describe("For a clip that continues the one before from its last frame: if it starts noticeably sharper than that clip ends (a visible 'skip' at the join), it opens equally soft and sharpens over this many seconds (1 is good). Measured automatically; does nothing when the two already match."),
            saturation: z.number().min(0.5).max(2).optional().describe("Scales this clip's colour (1 = as is). For a clip animated from the last frame of the one before, which can come back paler, so the join shows: measure both sides and match."),
            crop: z
              .object({
                x: z.number().min(0).max(1).optional().describe("Left edge, as a fraction of the width. Default: centred."),
                y: z.number().min(0).max(1).optional().describe("Top edge, as a fraction of the height. Default: centred."),
                w: z.number().min(0.1).max(1).describe("Width kept, as a fraction (0.8 = a 1.25x punch-in)."),
                h: z.number().min(0.1).max(1).optional().describe("Height kept; defaults to w, which keeps the frame's shape."),
              })
              .optional()
              .describe("Punch in on part of this clip, e.g. {x: 0, y: 0, w: 0.78} drops the bottom and right edges to hide something the model put in a corner."),
          })
          .nullable(),
      )
      .optional()
      .describe("One entry per clip, in play order: the seconds of that clip to keep, e.g. [{from: 0.6}, null, {to: 8.4}] cuts a dead start off clip 1 and an awkward pause off the end of clip 3 (null keeps a clip whole). The same clip may be listed twice with two windows to cut a repeated or fluffed line out of its middle. Use flow_transcribe's word times to find the cut points, and never cut inside a stray sound at the start of a take."),
    end_card: z
      .object({
        text: z.string().min(1).max(120).describe("The words, e.g. 'Link in bio' or 'Desk lamp · link below'. A line break starts a new line."),
        seconds: z.number().min(1).max(10).optional().describe("How long it shows. Default 2.5."),
      })
      .optional()
      .describe("A closing card: big centred words over the film's own last frame, blurred and darkened. Free, made on this computer."),
    inserts: z
      .array(
        z.object({
          clip: z.string().min(1).describe("Absolute path of the cutaway clip, e.g. a product close-up."),
          over: z.number().int().min(1).describe("Which clip it covers, counting from 1 in play order."),
          at: z.number().min(0).describe("Where it starts, in seconds into that clip's kept part (after its trim)."),
          seconds: z.number().min(0.2).optional().describe("How long it shows. Default: as long as the cutaway lasts, or to the end of the covered clip."),
          from: z.number().min(0).optional().describe("Start inside the cutaway clip. Default 0."),
          volume: z.number().min(0).max(1).optional().describe("The cutaway's own sound under the covered clip's sound. Default 0.3."),
          crop: z
            .object({ x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), w: z.number().min(0.1).max(1), h: z.number().min(0.1).max(1).optional() })
            .optional()
            .describe("Crop the cutaway like a clip's `trims` crop (fractions), e.g. to take a vertical picture out of a 16:9 export."),
        }),
      )
      .optional()
      .describe("B-roll cutaways: show another clip's picture over part of a clip while that clip's own sound keeps playing - the person keeps talking over the product shot and the picture cuts back to them mid-take, in sync and at the same loudness. Better than voice_lines when the line comes from one of the film's own clips."),
    size: z
      .string()
      .regex(/^\d{2,4}x\d{2,4}$/)
      .optional()
      .describe("Film size as WIDTHxHEIGHT, e.g. '1080x1920' for a phone-ready vertical master. Default: the biggest clip, after any crop."),
    loudness: z
      .number()
      .min(-30)
      .max(-9)
      .optional()
      .describe("Level the finished film's sound to this loudness in LUFS. Flow's takes come out near -24, which is quiet on a phone; social video sits around -14."),
    remove_watermark: z
      .boolean()
      .optional()
      .describe("Paint out the sparkle mark Google's video models put in the bottom-right corner, found automatically and filled from the pixels around it (no crop). The invisible SynthID mark stays, and platforms still expect an AI-content label."),
    watermark_margin: z.number().min(0).max(40).optional().describe("With remove_watermark: grow the mask by this many pixels and make it a diamond. Use about 10 after a long Extend chain, where the mark has been redrawn thicker. Look at the corner afterwards."),
  },
  transcribe: {
    video: z.string().min(1).describe("Absolute path of a video or audio file on this computer."),
    language: z.string().default("auto").describe("Spoken language code (en, es, tr, ja...) or auto. Pass it whenever you know it."),
    words: z.boolean().default(true).describe("Include every word with its start and end time in seconds."),
  },
  caption_preview: captionFields,
  presenter: {
    project: z.string().min(1).describe("Films folder to save into."),
    presenter: z.string().min(1).describe("Absolute path of the talking recording (an avatar video, say). Its sound plays throughout."),
    segments: z
      .array(
        z.object({
          from: z.number().min(0).describe("Start in the recording, in seconds."),
          to: z.number().min(0).describe("End in the recording, in seconds."),
          layout: z.enum(["full", "corner"]).describe("full: the presenter fills the frame. corner: a circle in the corner over `background`."),
          zoom: z
            .object({ from: z.number().min(1).max(3).optional(), to: z.number().min(1).max(3).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional() })
            .optional()
            .describe("Full layout only. A slow move from `from` to `to`, where 1 is the whole frame; x and y are the point to zoom toward, as fractions of the frame (default 0.5, 0.45)."),
          background: z
            .object({
              clip: z.string().min(1),
              from: z.number().min(0).optional(),
              retime: z.array(z.object({ from: z.number().min(0), to: z.number().min(0), speed: z.number().min(0.1).max(8) })).optional().describe("Parts of the clip to play faster or slower, so its action lands on the presenter's words. Times are in the original clip; `from` above is measured after this."),
            })
            .optional()
            .describe("Corner layout only: the clip behind the presenter, and where in it to start."),
          shrink: z.number().min(0.1).max(3).optional().describe("Corner layout only: animate from full frame into the circle over this many seconds at the start of the stretch."),
        }),
      )
      .min(1)
      .describe("The film in order. Each stretch is cut in as listed."),
    corner: z
      .object({
        position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]).optional(),
        size: z.number().min(0.15).max(0.7).optional().describe("Circle diameter as a fraction of the frame's height. Default 0.36: readable on a phone."),
        face: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.1).max(1) }).optional().describe("The square of the recording to show in the circle: centre x, centre y, width, as fractions of the recording."),
        margin: z.number().min(0).max(0.2).optional(),
        ring_color: z.string().optional(),
      })
      .optional(),
    size: z.string().regex(/^\d{2,4}x\d{2,4}$/).optional().describe("Film size. Default 1920x1080."),
    output_name: z.string().optional(),
  },
  captions: {
    ...captionFields,
    project: z.string().optional().describe("Films folder to save into. Default: the video's own folder when it is already in the films folder, otherwise 'Captions'."),
  },
  caption_setup: {},
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    references: z
      .array(
        z.object({
          image: z.string().min(1).describe("Absolute image path, or 'asset:<title>' for an image or character already in the Flow project."),
          name: z.string().min(1).max(40).describe("Short name the scenes use for it, e.g. 'Ines' or 'the station'."),
        }),
      )
      .max(10)
      .optional()
      .describe(
        "Reference images for the whole batch (characters, places, objects), attached once in the agent's composer like the + button does, so every scene stays on-model. Pair with scene_references to say which scenes use which.",
      ),
    scene_references: z
      .array(z.array(z.string()))
      .optional()
      .describe("One list per scene, in scene order: the reference names that scene uses (empty list for none). Without it the agent decides which references fit each scene."),
  },
  voices: {},
  narrate: {
    project: z.string().min(1).describe("Folder for the narration audio."),
    engine: z
      .enum(["kokoro", "gemini"])
      .default("kokoro")
      .describe(
        "'kokoro' (the default) is Kokoro, a free voice that runs on this computer: no key, no quota, any length; the first take downloads its model once (326 MB). 'gemini' uses Google AI Studio's text-to-speech - the same voices Flow has, free on the AI Studio tier but with a daily limit, needs a key in ~/.flow-mcp/gemini-key; when that limit is used up the take is recorded with Kokoro instead and the result says so.",
      ),
    text: z.string().min(1).max(3000).describe("The line to speak. About 2.5 words per second: 25 words fit 10 s, 75 words fit 30 s. Record a whole narration in one take."),
    voice: z
      .string()
      .min(1)
      .optional()
      .describe("Voice name from flow_voices for the chosen engine. Defaults: am_michael for Kokoro (try af_heart, af_bella, bf_emma), Charon for Google (Aoede, Gacrux...)."),
    speed: z.number().min(0.5).max(2).optional().describe("Kokoro only: speaking speed, 1 = normal. 0.9 is a calmer narrator pace."),
    style: z.string().max(200).optional().describe("Delivery note for the 'gemini' engine, e.g. 'slowly and warmly'. Keep it to a few words: long notes make the model ramble."),
  },
  edit: {
    project: z.string().min(1).describe("Local folder for the edited clip."),
    asset: z.string().min(1).describe("Title (or title prefix) of a video already in the Flow project; see flow_assets."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Flow shows no quote for edits, so max_credits cannot protect you: a 4 s clip cost 20 credits when measured. The real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
  },
  continue_shot: {
    project: z.string().min(1).describe("Local folder for the new clip."),
    from_asset: z.string().min(1).describe("Title (or title prefix) of the video to continue from; see flow_assets."),
    prompt: z.string().min(1).describe("What happens in the new clip, written as one continuous shot with one camera move."),
    attach: z
      .array(z.string().min(1))
      .max(3)
      .optional()
      .describe("Characters or avatars to keep attached, by name, e.g. ['Me'] for your own Flow avatar or ['Pip']. This is the whole point of this tool: the normal composer cannot hold a character and a start frame at the same time."),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    mode: z
      .enum(["exact", "likeness"])
      .default("exact")
      .describe(
        "'exact' uses Flow's first-frame animation (I2V): the clip begins on the source clip's real last frame, invisible cut, but attached characters are IGNORED - the likeness has to come from the frame itself. 'likeness' uses reference-to-video (R2V): the character stays locked but the opening frame is only approximate. Flow cannot do both; this is a model limit, not a UI one.",
      ),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Agent mode shows no credit quote before it runs, so max_credits cannot protect you; the real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    force: z
      .boolean()
      .optional()
      .describe("Skip the guard that refuses to run when Flow already holds a fresh-looking continuation of this clip. Only pass it when you have checked the grid and genuinely want another paid take."),
  },
  trash: { name: z.string().min(1).describe("Exact title of the item to move to Flow's Trash, as listed by flow_assets.") },
  set_key: { key: z.string().min(1).max(200) },
  discard: { path: z.string().min(1).describe("A saved film, still, narration or whole project folder inside the films folder, to move to this computer's bin (Mac Trash, Windows Recycle Bin).") },
  outputs: {},
  characters: {},
  character_edit: {
    name: z.string().min(1).describe("Character to change, as listed by flow_characters."),
    change: z
      .string()
      .min(1)
      .max(600)
      .optional()
      .describe(
        "What to change about the look, e.g. 'make his coat red, keep everything else the same'. Leave it out to only save the character's current portrait (after a change made by hand in Flow, or one whose portrait never arrived).",
      ),
    look: z
      .string()
      .min(1)
      .max(1500)
      .optional()
      .describe(
        "The character's whole description AFTER the change, e.g. the old one with 'navy coat' swapped for 'red coat'. Scenes quote it word for word to hold the design, so a stale colour in it fights the new portrait. Without it, the change is added to the end of the old description.",
      ),
  },
  new_project: {
    title: z.string().max(80).optional().describe("Name for the new project, e.g. 'Desk lamp UGC ad'. Default: Flow's own date-and-time name."),
  },
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then reference it as 'asset:<name>' in reference_images."),
    describe: z
      .string()
      .max(1200)
      .optional()
      .describe("What the character looks like. Flow draws the portrait first (free image), then builds the character from it. Use this or `image`."),
    image: z
      .string()
      .min(1)
      .optional()
      .describe("Existing picture instead of `describe`: absolute path, or 'asset:<title>' of an image already in the Flow project."),
    aspect_ratio: z.enum(["3:4", "1:1", "9:16", "16:9", "4:3"]).optional().describe("Frame for the drawn portrait when using `describe`. Default 3:4."),
    look: z
      .string()
      .max(1200)
      .optional()
      .describe("With `image`: the person in the picture in words (face, hair, clothes). Every scene's character lock quotes it word for word, so describe only what the picture shows. Without it, an older description saved under the same name is dropped."),
    personality: z.string().max(500).optional().describe("How the character acts; Flow uses it when crafting scenes."),
    voice: z.string().optional().describe("Flow voice name, e.g. 'Charon' (male, informative) or 'Aoede' (female, breezy)."),
  },
  techniques: { category: z.enum(["angle", "camera", "product", "transition", "image"]).optional() },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export const jobView = ({ id, status, params, files, attempts, credits, progress, note, error, failed_scenes }: Job) => ({
  id,
  status,
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  attempts,
  credits,
  progress,
  files,
  note,
  error,
  failed_scenes,
});

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  production(a: Args<"production">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  voices(): Promise<unknown>;
  narrate(a: Args<"narrate">): Promise<unknown>;
  new_project(a: Args<"new_project">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  trash(a: Args<"trash">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  set_key(a: Args<"set_key">): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
  transcribe(a: Args<"transcribe">): Promise<unknown>;
  caption_preview(a: Args<"caption_preview">): Promise<unknown>;
  captions(a: Args<"captions">): Promise<unknown>;
  presenter(a: Args<"presenter">): Promise<unknown>;
  caption_setup(): Promise<unknown>;
}

// Flow's own voices: still offered when giving a character a voice, but narration no longer goes through Flow.
export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

// DKE fork, 14 Nov 2026. Video model per purpose; "A|B" = first one Flow still offers. Quotes read from Flow that day
// at 720p, 8 s, 9:16, x1: Veo Lite LP 0, Veo Lite 5, Veo Fast 10, Omni 1.2 Flash 24, Veo Quality 100.
// A/B on one acting shot (same START/END and prompt): the three Veo models acted almost identically (improvised a
// hand-over-mouth giggle, intensity 4), so price bought no naturalness; Omni 1.2 Flash followed the written beats
// (eyes, then fingertips, then a smile from the eyes, intensity 3). Hence hero = two Omni takes to choose from, not Veo
// Quality. A Veo draft does NOT preview Omni's acting: if the draft is right, keep the draft clip itself.
const TIERS = {
  draft: "Veo 3.1 - Lite [Lower Priority]|Veo 3.1 - Lite",
  final: "Omni 1.2 Flash",
  hero: "Omni 1.2 Flash",
} as const;

// Scenes with people get the acting rules that made shots read as filmed rather than generated (sinema-natural 04).
const PEOPLE = /\b(she|he|her|his|they|woman|women|man|men|girl|boy|person|people|talent|face|hands?|fingers?|smiles?|eyes)\b/i;
const PERFORMANCE =
  "PERFORMANCE — real people filmed in real time, not animation: real-time speed, no slow motion. Every movement has weight: a small anticipation, the action, then easing out; body weight shifts and fabric follows a moment later. The eyes lead: the gaze moves first, the head follows, the face reacts last. Expressions are motivated by what is visible in the scene, intensity 2-3 of 5, growing and settling gradually, never snapping on or freezing at the peak. Natural blinks every few seconds, quiet breathing visible in the shoulders, slight asymmetry. Hands move little and stay relaxed: a touch, then rest, five fingers with naturally bending joints. When a finger is raised or counted, number one is the index finger; the middle finger is never raised alone (an offensive gesture). Skin keeps real texture with pores and fine hair. Faces, bodies and objects keep their exact shape in every frame.";

const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

// The params one scene of flow_generate queues, kept pure so the opt-in proof (`node dist/core.js --cek`) can compare
// them with what generate() queued before production mode existed.
export function buildParams(
  { chain_previous, reference_previous, technique, angle, outfit, on_screen_text, regenerate: _regenerate, tier, performance, shot, force, crop_center, ...scene }: Scene,
  ctx: { prevId?: string; output_dir: string; file_stem: string; production?: boolean },
): { params: SceneParams; key?: string } {
  if (scene.type === "video" && tier && !scene.model) {
    scene.model = TIERS[tier];
    if (tier === "hero") scene.variants ??= 2; // two takes; quote ~48, so max_credits must be raised on purpose
    if (!scene.model.startsWith("Omni")) delete scene.resolution, delete scene.duration; // Veo: fixed 8 s, no resolution radio
  }
  const acting = scene.type === "video" && performance !== false && PEOPLE.test(scene.prompt) ? ` ${PERFORMANCE}` : "";
  const phrase = technique ? techniqueById(technique)!.phrase : "";
  const opening = angle ? `${techniqueById(angle)!.phrase} ` : "";
  // A referenced character must come out identical, not merely similar, so the scene says so explicitly. The
  // wording stays medium-neutral: the same lock has to serve a flat cartoon character and a photoreal avatar.
  const cast = (scene.reference_images ?? [])
    .filter((r) => r.startsWith("asset:"))
    .map((r) => r.slice(6).trim())
    .filter((n) => characterLook(n) !== undefined || /^[\w .'-]{1,60}$/.test(n));
  // With an outfit the lock still pins face, hair and build, but the clothes come from the scene: otherwise the
  // saved look (Skye's denim shirt) fights a costume the prompt asks for.
  const lock = cast.length
    ? ` CHARACTER LOCK — ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions,${outfit ? "" : " same clothing items in the same colours,"} same hands, and the same rendering style and level of realism as the reference. Never redesign, ${outfit ? "" : "restyle, "}re-proportion, re-age or re-colour them${outfit ? "" : ", and never swap an item for a similar one"}.${cast
        .map((n) => (characterLook(n) ? ` ${n} is exactly: ${characterLook(n)}.` : ""))
        .join("")}${outfit ? ` WARDROBE IN THIS SCENE: ${outfit.trim().replace(/\.$/, "")}. This replaces any clothing in the reference image or the description above, and stays identical for the whole scene.` : ""}`
    : "";
  // Omni burns its own subtitles into talking clips now and then, garbled ("thyel", "voch"), even when the prompt
  // says "no captions" near the end (protein soda clip 1, 15 credits). Every video therefore opens AND closes on it,
  // unless the scene really wants words in the picture. Captions are added afterwards by flow_captions.
  const noText = scene.type !== "image" && !on_screen_text;
  const textFirst = noText ? "NO SUBTITLES, NO CAPTIONS, NO TEXT OF ANY KIND ON SCREEN. " : "";
  const textLast = noText
    ? " NO TEXT ON SCREEN: never add subtitles, captions, titles, speech transcripts, words or letters anywhere in the picture, at any moment; any speech is heard only, never written."
    : "";
  const inherit = reference_previous
    ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later."
    : "";
  const params = {
    ...scene,
    prompt: `${textFirst}${opening}${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lock}${inherit}${acting}${textLast}`,
    chain_from: chain_previous ? ctx.prevId : undefined,
    reference_from: reference_previous ? ctx.prevId : undefined,
    output_dir: ctx.output_dir,
    file_stem: ctx.file_stem,
    // Production mode only: carried to the job (credit log). Elsewhere they are dropped, so params stay as before.
    // tier rides along with shot so the worker can re-run the gates (draft = free) after resolving shot:/crop: frames.
    ...(ctx.production && shot ? { shot, ...(tier ? { tier } : {}) } : {}),
    ...(ctx.production && force ? { force } : {}),
    ...(ctx.production && crop_center ? { crop_center } : {}),
  };
  // Local patch: the same image request again returns the earlier image instead of another tile in Flow. Scenes
  // that reference the previous scene depend on it, so they are always generated.
  const key = scene.type === "image" && !reference_previous ? imageKey(params) : undefined;
  return { params, key };
}

// ---- Production mode (produksi.json) helpers: inert for projects without that file. ----

// Seconds of a clip this project downloaded itself: Flow tiles are renamed "<project>-<stem>", the file is <stem>.mp4.
async function localClipSeconds(output_dir: string, asset: string): Promise<number | undefined> {
  const prefix = `${basename(output_dir)}-`;
  const stem = asset.startsWith(prefix) ? asset.slice(prefix.length) : asset;
  const file = join(output_dir, `${stem}.mp4`);
  if (!/^[\w.-]+$/.test(stem) || !existsSync(file)) return undefined;
  try {
    const { stdout } = await execFileP(process.env.FLOW_MCP_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 10_000 });
    const s = Number(String(stdout).trim());
    return Number.isFinite(s) && s > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

// Paid tools with no Flow quote (edit, continue/Extend): a conservative estimate checked against the budget before the
// job is queued. Returns the extra job params ({} outside production mode, so those params stay as they were).
async function estimateUnquoted(output_dir: string, kind: "edit" | "continue", asset?: string): Promise<{ estimate?: number }> {
  const left = budgetLeft(output_dir);
  if (left === undefined) return {};
  const estimate = estimateCost(kind, kind === "edit" && asset ? await localClipSeconds(output_dir, asset) : undefined);
  if (overBudget(left, estimate)) throw new Error(budgetMessage(left, estimate, "perkiraan"));
  return { estimate };
}

const execFileP = promisify(execFile);

// After a job is done: one credit-log line per downloaded video (spentCredits counts each job id once). A failure to
// log must not fail a job whose credits are already spent, so it only adds a note.
export function logDone(job: Job, files: string[]): string[] {
  const s = job.params;
  try {
    if (!loadProduction(s.output_dir)) return files;
    const t = new Date().toISOString();
    const est = s.estimate !== undefined;
    for (const file of files.filter((f) => /\.(mp4|webm|mov)$/i.test(f))) {
      appendLog(s.output_dir, {
        t, job: job.id, shot: s.shot, file: basename(file),
        // No-quote tools are charged their pre-run estimate, never the balance difference: the account is shared, so
        // that difference can be far off either way (seen: -500, +1380). It is kept in `measured`, for information.
        quote: est ? s.estimate : job.credits,
        credits: est ? Math.max(s.estimate!, 0) : job.credits,
        ...(est ? { estimate: true } : {}),
        ...(est && job.credits !== undefined ? { measured: job.credits } : {}),
        ...(s.force ? { force: s.force } : {}),
      });
    }
    if (est) {
      const real = job.credits !== undefined ? `selisih saldo ${job.credits} kredit (${MEASURED_NOTE})` : "saldo tak terbaca";
      job.note = [job.note, `anggaran dibebani perkiraan ${s.estimate} kredit; ${real}`].filter(Boolean).join(" · ");
    }
  } catch (e) {
    job.note = [job.note, `log produksi gagal ditulis: ${(e as Error).message}`].filter(Boolean).join(" · ");
  }
  return files;
}

// Indirection so the self-check can stub the Flow run and prove a refused job never reaches it.
export const runners = { generation: runGeneration };

export class LocalCore implements Core {
  private queue: JobQueue = new JobQueue(async (job) => {
    const { chain_from, reference_from } = job.params;
    if (reference_from) {
      const still = this.queue.get(reference_from)?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
      if (!still) throw new Error(`reference_previous: the previous scene (${reference_from}) produced no image.`);
      job.params.reference_images = [still, ...(job.params.reference_images ?? [])].slice(0, 3);
    }
    // A clip given as the first frame means "carry on from where it ends", so a clip made in an earlier call can be
    // continued after the user has looked at it.
    const ff = job.params.first_frame;
    if (ff && !ff.startsWith("asset:") && /\.(mp4|webm|mov)$/i.test(ff))
      job.params.first_frame = job.params.first_frame_at !== undefined ? await extractFrameAt(ff, job.params.first_frame_at) : await extractLastFrame(ff);
    // And a clip given as the last frame means "end where it begins": with both, a middle clip can be redone without
    // touching the clips on either side.
    const lf = job.params.last_frame;
    if (lf && !lf.startsWith("asset:") && /\.(mp4|webm|mov)$/i.test(lf)) job.params.last_frame = await extractFirstFrame(lf);
    if (chain_from) {
      const clip = this.queue.get(chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
      if (!clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
      job.params.first_frame = await extractLastFrame(clip);
    }
    // Production mode: shot:/crop: frame references become files in frame/turunan/ right before the job runs (the
    // parent clip may have been chosen after queueing). A face below 0.80 fails the job here, before Flow is opened.
    if (isDerivedRef(job.params.first_frame) || isDerivedRef(job.params.last_frame)) {
      const p = job.params;
      const notes = await resolveSceneFrames(p.output_dir, p, { exempt: !!p.force?.trim() || !paidVideo(p), tag: job.id });
      job.note = [job.note, ...notes].filter(Boolean).join(" · ");
      // G2 was deferred at queue time for a derived pair: re-run the gates now that the frames are files, so a pair
      // whose face check did not record a pass (produksi.json edited meanwhile, say) fails here, before Flow and credits.
      const g = gate(p.output_dir, p);
      if (!g.ok) throw new Error(`Gerbang saat job jalan: ${g.reason}`);
    }
    // Production mode: tools without a Flow quote are re-checked against the budget right before they run, because
    // jobs ahead of them in the queue may have spent it since they were queued.
    if (job.params.estimate !== undefined) {
      const left = budgetLeft(job.params.output_dir);
      if (left !== undefined && overBudget(left, job.params.estimate)) throw new Error(budgetMessage(left, job.params.estimate, "perkiraan"));
    }
    if (job.params.continue_from) return logDone(job, await runContinue(job));
    if (job.params.agent_scenes) return runAgentBatch(job);
    if (job.params.edit_asset) return logDone(job, await runEdit(job));
    const files = await runners.generation(job);
    if (job.params.dedup_key && files.length) rememberImages(job.params.dedup_key, files);
    return logDone(job, files);
  });

  async status({ detailed }: Args<"status">) {
    const flow = await getFlowState(detailed && !this.queue.busy);
    return { flow, pacing: this.queue.pausedReason, output_root: OUTPUT_ROOT, jobs: this.queue.list().map(jobView) };
  }

  async generate({ project, scenes }: Args<"generate">) {
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
    if (noPrev >= 0) throw new Error("Scene 1 has no previous scene to reference.");
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);
    const badAngle = scenes.find((s) => s.angle && techniqueById(s.angle)?.category !== "angle");
    if (badAngle) throw new Error(`Unknown angle "${badAngle.angle}". Call flow_techniques with category "angle" for valid ids.`);

    const output_dir = projectDir(project);
    // Production gates G1/G2 (produksi.json only; without it every scene passes untouched). Checked for every scene
    // before any job exists, so a refused scene never leaves half a batch queued.
    // shot:/crop: frame references: production mode only, parent clip must exist (cheap checks, no ffmpeg).
    const badRefs = scenes.flatMap((s, i) => {
      try { checkFrameRefs(output_dir, s.chain_previous && !s.first_frame ? { ...s, first_frame: "(chain_previous)" } : s); return []; } catch (e) { return [`Scene ${i + 1}: ${(e as Error).message}`]; }
    });
    if (badRefs.length) throw new Error(badRefs.join("\n"));
    const gates = scenes.map((s) => gate(output_dir, s));
    const refused = gates.flatMap((g, i) => (g.ok ? [] : [`Scene ${i + 1}: ${g.reason}`]));
    if (refused.length) throw new Error(refused.join("\n"));
    const production = existsSync(join(output_dir, "produksi.json"));
    // Continue numbering after whatever is already on disk or queued, so reruns never overwrite earlier scenes.
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    const offset = Math.max(0, ...onDisk, ...queued);
    const jobs: Job[] = [];
    let reused = 0;
    for (const [i, scene] of scenes.entries()) {
      const { params, key } = buildParams(scene, { prevId: jobs[i - 1]?.id, output_dir, file_stem: `scene-${String(offset + i + 1 - reused).padStart(2, "0")}`, production });
      const earlier = key && !scene.regenerate ? earlierImages(key) : undefined;
      if (earlier) {
        reused++;
        jobs.push(this.queue.addDone({ ...params, file_stem: basename(earlier[0]).replace(/\.[^.]+$/, "") }, earlier,
          "already in this project (same prompt, model, ratio and references): nothing sent to Flow. Pass regenerate: true for a new take."));
        continue;
      }
      const job = this.queue.add({ ...params, dedup_key: key });
      const g = gates[i];
      if (g.ok && g.derived) job.note = "G2 ditunda: pasangan turunan (shot: + crop:) diverifikasi wajah saat job jalan";
      if (g.ok && g.force) {
        job.note = `force: ${g.force} (gerbang G1/G2 dilewati; anggaran tetap dicek)`;
        try {
          appendLog(output_dir, { t: new Date().toISOString(), job: job.id, shot: scene.shot, tier: scene.tier, force: g.force });
        } catch (e) {
          job.note += ` · log produksi gagal ditulis: ${(e as Error).message}`;
        }
      }
      jobs.push(job);
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job with id ${job_id}. Use flow_status to list jobs.`);
    return jobView(job);
  }

  async retry({ job_ids }: Args<"retry">) {
    const ids = job_ids ?? this.queue.list().filter((j) => j.status === "failed" || j.failed_scenes?.length).map((j) => j.id);
    const jobs: Job[] = [];
    for (const id of ids) {
      const job = this.queue.get(id);
      const p = job?.params;
      if (job?.failed_scenes?.length && p?.agent_scenes && job.status === "done") {
        // A batch that finished with some images still failed: make just those again, under their own scene numbers,
        // instead of re-running the whole batch. The list moves to the new job, so it is never retried twice.
        const base = Number(p.file_stem.match(/\d+/)?.[0] ?? 1);
        const numbers = p.agent_numbers ?? p.agent_scenes.map((_, i) => base + i);
        const pick = job.failed_scenes.map((n) => numbers.indexOf(n)).filter((i) => i >= 0);
        job.failed_scenes = undefined;
        jobs.push(
          this.queue.add({
            ...p,
            prompt: `Agent batch: ${pick.length} failed image(s) again`,
            agent_scenes: pick.map((i) => p.agent_scenes![i]),
            agent_numbers: pick.map((i) => numbers[i]),
            agent_scene_refs: p.agent_scene_refs ? pick.map((i) => p.agent_scene_refs![i]) : undefined,
            file_stem: `scene-${String(numbers[pick[0]]).padStart(2, "0")}`,
          }),
        );
        continue;
      }
      const again = this.queue.retry(id);
      if (again) jobs.push(again);
    }
    if (!jobs.length) throw new Error("Nothing to retry: no failed jobs, and no batch with failed images.");
    return { jobs: jobs.map(jobView) };
  }

  async assets({ kind }: Args<"assets">) {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind }) => ({ name, kind }));
  }

  async download({ project, assets, quality }: Args<"download">) {
    if (this.queue.busy) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    // Numbering from 1 every call overwrote clips fetched earlier - it destroyed a finished shot once. Carry on from
    // the highest clip-NN already on disk instead.
    let next = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^clip-(\d+)/)?.[1] ?? 0))) + 1;
    for (const name of assets) {
      try {
        files.push(...(await downloadAsset(name, join(dir, `clip-${String(next++).padStart(2, "0")}`), quality)));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
      }
    }
    return { dir, files };
  }

  async assemble({ project, voice_lines, ...rest }: Args<"assemble">) {
    const dir = projectDir(project);
    if (!voice_lines?.length) return assemble({ dir, ...rest });
    mkdirSync(dir, { recursive: true });
    const track = await voiceTrack(voice_lines, join(dir, `${rest.output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`));
    const film = await assemble({ dir, ...rest, voiceover: track.file });
    return { ...film, voice: track };
  }

  transcribe = transcribeHere;
  caption_preview = captionPreviewHere;
  captions = captionsHere;
  presenter = presenterHere;
  production = productionHere;
  caption_setup = captionSetupHere;

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { root: OUTPUT_ROOT, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
    const projects = readdirSync(OUTPUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(OUTPUT_ROOT, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root: OUTPUT_ROOT, projects };
  }

  private nextStem(output_dir: string, prefix: string): string {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix)).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
    return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
  }

  async agent({ project, scenes, aspect_ratio, download_quality, references, scene_references }: Args<"agent">) {
    const output_dir = projectDir(project);
    // Agent mode shows no price, so in production mode it cannot be held to the budget: plain image scenes can.
    if (existsSync(join(output_dir, "produksi.json"))) throw new Error("Mode produksi: pakai flow_generate type image (gratis, 0 kredit); mode agen tidak menampilkan harga.");
    if (scene_references && scene_references.length !== scenes.length) {
      throw new Error(`scene_references has ${scene_references.length} entries for ${scenes.length} scenes; give one list per scene (empty for none).`);
    }
    const known = new Set((references ?? []).map((r) => r.name.toLowerCase()));
    const unknown = [...new Set((scene_references ?? []).flat().filter((n) => !known.has(n.toLowerCase())))];
    if (unknown.length) throw new Error(`scene_references names ${unknown.map((n) => `"${n}"`).join(", ")}, which is not in references.`);
    for (const r of references ?? []) {
      if (!r.image.startsWith("asset:") && !existsSync(r.image)) throw new Error(`Reference image not found: ${r.image}`);
    }
    const job = this.queue.add({
      agent_refs: references?.length ? references : undefined,
      agent_scene_refs: references?.length ? scene_references : undefined,
      prompt: `Agent batch: ${scenes.length} images`,
      type: "image",
      max_credits: 0,
      aspect_ratio,
      download_quality,
      agent_scenes: scenes,
      output_dir,
      file_stem: this.nextStem(output_dir, "scene"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  async edit({ project, asset, prompt, download_quality }: Args<"edit">) {
    const output_dir = projectDir(project);
    const estimate = await estimateUnquoted(output_dir, "edit", asset);
    const job = this.queue.add({ prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, output_dir, file_stem: this.nextStem(output_dir, "edit"), ...estimate });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Flow's composer takes a start frame OR a character, never both; agent mode takes both, so this goes that way.
  async continue_shot({ project, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force }: Args<"continue_shot">) {
    // A lost queue entry is not proof that nothing ran: when the owner process is replaced mid-job the job vanishes
    // while Flow carries on and charges for it. Re-running then spends twice, which is exactly what happened on
    // 2026-09-20. Flow's own grid is the only honest record, so ask it before starting another paid generation.
    if (!force) {
      const recent = (await listAssets()).slice(0, 6).filter((a) => a.kind === "video");
      const source = from_asset.toLowerCase();
      const echo = recent.find((a) => {
        const n = a.name.toLowerCase();
        return n !== source && !n.startsWith(source) && words(n).some((w) => words(source).includes(w));
      });
      if (echo) {
        throw new Error(
          `Flow already holds a recent clip called "${echo.name}", which looks like a continuation of "${from_asset}" that may have just been generated and charged for. ` +
            `Check it with flow_assets / flow_download before spending again. Pass force: true if you really do want another take.`,
        );
      }
    }
    const output_dir = projectDir(project);
    const estimate = await estimateUnquoted(output_dir, "continue");
    const job = this.queue.add({
      prompt,
      type: "video",
      max_credits: 0,
      continue_from: from_asset,
      attach,
      continue_mode: mode,
      aspect_ratio,
      download_quality,
      output_dir,
      file_stem: this.nextStem(output_dir, "shot"),
      ...estimate,
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Moves a file or a project folder from the films folder to the system's bin - recoverable from there, never
  // erased. Anything outside the films folder is refused, so a bad path can never reach the rest of the Mac.
  async discard({ path }: Args<"discard">) {
    const target = resolve(path);
    // relative() works with either separator; a path that climbs out ("..") or lands on another drive is refused.
    const rel = relative(OUTPUT_ROOT, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only things inside your films folder can be moved to the bin from here.");
    if (!existsSync(target)) throw new Error("That file is already gone.");
    return { trashed: target, to: moveToBin(target), bin: BIN };
  }

  async trash({ name }: Args<"trash">) {
    if (this.queue.busy) throw new Error(BUSY);
    return trashAsset(name);
  }

  async new_project({ title }: Args<"new_project">) {
    if (this.queue.busy) throw new Error(BUSY);
    const made = await createProject(title);
    return { ...made, note: "The Flow window now has this empty project open; every generation goes into it. Characters belong to a project, so make them again here." };
  }

  async character(a: Args<"character">) {
    if (this.queue.busy) throw new Error(BUSY);
    if (!a.image && !a.describe) throw new Error("Pass either `describe` (Flow draws the portrait) or `image`.");
    const made = await createCharacter(a);
    // Every scene quotes the saved description in its character lock, so a character made from a picture must not
    // inherit an older description saved under the same name: it described someone else (a "Maya" with a ponytail and
    // a mustard sweater, when the new picture showed loose hair and a grey tee).
    if (a.describe) rememberCharacter(a.name, a.describe);
    else if (a.look) rememberCharacter(a.name, a.look);
    else forgetCharacter(a.name);
    return { ...made, use_as: `asset:${a.name}` };
  }

  async character_edit({ name, change, look }: Args<"character_edit">) {
    if (this.queue.busy) throw new Error(BUSY);
    const out = await editCharacter(name, change);
    // Every scene that references the character quotes this description in its character lock, so it has to describe
    // the NEW look - "deep navy coat" left in it would argue with a portrait whose coat is now red.
    if (look) rememberCharacter(name, look);
    else if (change) rememberCharacter(name, `${characterLook(name) ?? ""} Changed since, and this wins over anything above: ${change.replace(/[.\s]+$/, "")}`.trim());
    return { ...out, use_as: `asset:${name}` };
  }

  async characters() {
    if (this.queue.busy) throw new Error(BUSY);
    return (await listCharacters()).map((name) => ({ name, use_as: `asset:${name}` }));
  }

  // Panel only: deliberately NOT registered as an MCP tool, so a key typed into Flow Studio never reaches Claude.
  async set_key({ key }: Args<"set_key">) {
    return saveGeminiKey(key);
  }

  voices = voicesHere;
  narrate = narrateHere;

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }
}

// Narration never touches Chrome, so it runs in whichever process gets the call. A client then never depends on the
// owner's code: Claude Desktop's own flow-mcp process can be a release behind until the user restarts the app.
export async function voicesHere() {
  // The panel words itself from these, so a PC never reads "this Mac".
  const place = { computer: COMPUTER, bin: BIN, platform: process.platform };
  return { kokoro: KOKORO_VOICES, kokoro_ready: kokoroReady(), kokoro_mb: KOKORO_MB, gemini: GEMINI_VOICES, gemini_ready: Boolean(geminiKey()), place };
}

export async function narrateHere({ project, text, voice, engine, speed, style }: Args<"narrate">) {
  const output_dir = projectDir(project);
  mkdirSync(output_dir, { recursive: true });
  const taken = readdirSync(output_dir).map((f) => Number(f.match(/^narration-(\d+)/)?.[1] ?? 0));
  const target = join(output_dir, `narration-${String(Math.max(0, ...taken) + 1).padStart(2, "0")}.m4a`);
  const line = text.trim();
  if (engine === "kokoro") {
    const v = voice ?? KOKORO_DEFAULT_VOICE;
    return { output_dir, credits: 0, engine, voice: v, ...(await speakWithKokoro(line, v, target, speed)) };
  }
  const v = voice ?? "Charon";
  try {
    return { output_dir, credits: 0, engine, voice: v, ...(await speakWithGemini(line, v, target, style)) };
  } catch (err) {
    // The free AI Studio tier has a daily limit. Running out of it should not stop the film: Kokoro records the line
    // now, and the note says how to get the Google voice back once the limit resets.
    if (!/\b429\b|quota|RESOURCE_EXHAUSTED|rate limit/i.test(String((err as Error).message))) throw err;
    const spoken = await speakWithKokoro(line, KOKORO_DEFAULT_VOICE, target);
    return {
      output_dir, credits: 0, engine: "kokoro", voice: KOKORO_DEFAULT_VOICE, fell_back_from: "gemini", ...spoken,
      note: `Google AI Studio's daily limit is used up, so this take was recorded with Kokoro (${KOKORO_DEFAULT_VOICE}) instead. Record it again with ${v} once the limit resets.`,
    };
  }
}

// Captions never touch Flow or its queue: whisper.cpp hears the words, a headless Chrome of its own draws them. So,
// like narration, they run in whichever process gets the call and never wait for the owner to be restarted.
export async function transcribeHere({ video, language, words }: Args<"transcribe">) {
  const t = await transcribe(video, language);
  return {
    text: t.text,
    word_count: t.words.length,
    language: t.language,
    model: t.model,
    ...(words ? { words: t.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
  };
}

// Read-only and local: never touches Flow or its queue, so it runs in whichever process gets the call.
export async function productionHere({ project, format }: Args<"production">) {
  return checkReport(projectDir(project), format);
}

export async function presenterHere({ project, ...a }: Args<"presenter">) {
  return presenter({ ...a, dir: projectDir(project) });
}

export async function captionPreviewHere(a: Args<"caption_preview">) {
  return previewCaptions(a.video, a);
}

export async function captionsHere({ project, ...a }: Args<"captions">) {
  // Save next to the video when it is already one of the user's films, otherwise in a Captions folder.
  const rel = relative(OUTPUT_ROOT, dirname(a.video));
  const inFilms = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const dir = project ? projectDir(project) : inFilms ? dirname(a.video) : projectDir("Captions");
  mkdirSync(dir, { recursive: true });
  return burnCaptions(a.video, a, captionedName(dir, a.video));
}

export async function captionSetupHere() {
  return captionSetup();
}

// Self-check: `node dist/core.js --cek`. Opt-in proof: for scenes without shot/force in a project without produksi.json,
// buildParams() yields byte-for-byte the params generate() queued before production mode existed (golden captured from
// commit ba9a06e by stubbing the queue; fixtures/params.golden.json).
if (process.argv[1]?.endsWith("core.js") && process.argv.includes("--cek")) {
  const { readFileSync } = await import("node:fs");
  const assert = (c: unknown, m: string) => {
    if (!c) throw new Error(`cek gagal: ${m}`);
  };
  const input = JSON.parse(readFileSync(new URL("../fixtures/params.contoh.json", import.meta.url), "utf8"));
  const golden = JSON.parse(readFileSync(new URL("../fixtures/params.golden.json", import.meta.url), "utf8")) as string[];
  const { scenes } = z.object(shapes.generate).parse(input);
  const output_dir = "/tmp/flow-mcp-cek/kopi-pagi";
  const got = scenes.map((s, i) => {
    const { params, key } = buildParams(s, { prevId: i ? `job-${i}` : undefined, output_dir, file_stem: `scene-${String(i + 1).padStart(2, "0")}` });
    return JSON.stringify({ ...params, dedup_key: key });
  });
  assert(got.length === golden.length, "jumlah scene");
  got.forEach((g, i) => assert(g === golden[i], `scene ${i + 1}: params berbeda dari sebelum perubahan\n  kini: ${g}\n  dulu: ${golden[i]}`));
  // shot/force hanya ikut bila diberikan; selebihnya params tetap sama.
  const passed = buildParams({ ...scenes[0], shot: "S01", force: "uji" }, { output_dir, file_stem: "scene-01" });
  assert(JSON.stringify({ ...passed.params, dedup_key: passed.key }) === golden[0], "di luar mode produksi shot/force tak masuk params (golden tetap)");
  const withShot = buildParams({ ...scenes[0], shot: "S01", force: "uji" }, { output_dir, file_stem: "scene-01", production: true }).params;
  const { shot, force, tier: wTier, ...rest } = withShot;
  assert(shot === "S01" && force === "uji" && wTier === scenes[0].tier, "shot/force/tier dibawa ke job");
  assert(JSON.stringify(rest) === JSON.stringify(buildParams(scenes[0], { output_dir, file_stem: "scene-01" }).params), "selain shot/force identik");

  // generate()/edit()/continue_shot() end to end with the queue stubbed (nothing reaches Flow). OUTPUT_ROOT and
  // FLOW_MCP_HOME are fixed at import, so this part runs in a child process pointed at a throwaway folder.
  if (!process.env.FLOW_MCP_CEK_CHILD) {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "core-cek-"));
    const r = spawnSync(process.execPath, [process.argv[1], "--cek"], {
      stdio: "inherit",
      env: { ...process.env, FLOW_MCP_CEK_CHILD: "1", FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_HOME: join(root, "home") },
    });
    const { rmSync } = await import("node:fs");
    rmSync(root, { recursive: true, force: true });
    if (r.status !== 0) process.exit(r.status ?? 1);
    console.log("core ok");
  } else {
    const { mkdirSync: mkd, writeFileSync, readFileSync: rd, rmSync } = await import("node:fs");
    mkd(process.env.FLOW_MCP_HOME!, { recursive: true });
    const { spentCredits, latestClip } = await import("./produksi.js");
    const core = new LocalCore();
    let added: SceneParams[] = [];
    let n = 0;
    (core as any).queue = {
      add: (p: SceneParams) => (added.push(p), { id: `job-${++n}`, status: "queued", params: p, files: [], attempts: 0 }),
      addDone: () => { throw new Error("addDone tak diharapkan"); },
      list: () => [],
    };
    const gen = (sc: unknown[], project = "kopi-pagi") => core.generate(z.object(shapes.generate).parse({ project, scenes: sc }));
    const dir = projectDir("kopi-pagi");
    // 1. no produksi.json: generate() queues exactly the golden params
    await gen(input.scenes);
    const cur = added.map((p) => JSON.stringify(p).split(JSON.stringify(dir).slice(1, -1)).join(output_dir));
    assert(cur.length === golden.length && cur.every((c, i) => c === golden[i]), "generate() tanpa produksi.json = params sebelum perubahan");
    added = [];
    n = 0; // job ids (chain_from) restart, as in the golden run
    await gen(input.scenes.map((x: any) => ({ ...x, shot: "S01", force: "uji" })));
    const cur2 = added.map((p) => JSON.stringify(p).split(JSON.stringify(dir).slice(1, -1)).join(output_dir));
    assert(cur2.every((c, i) => c === golden[i]), "generate() tanpa produksi.json, shot/force diberikan -> params tetap golden");
    added = [];
    await core.agent({ project: "kopi-pagi", scenes: ["a"], aspect_ratio: "9:16" } as any);
    assert(added.length === 1, "agent images tanpa produksi.json tetap jalan");
    // edit/continue without produksi.json: no estimate key
    added = [];
    await core.edit({ project: "kopi-pagi", asset: "x", prompt: "make it rain", acknowledge_cost: true } as any);
    assert(added.length === 1 && !("estimate" in added[0]), "edit tanpa produksi.json: params tanpa estimate");
    // 2. production mode
    mkd(dir, { recursive: true });
    const prod = JSON.parse(rd(new URL("../fixtures/produksi.contoh.json", import.meta.url), "utf8"));
    writeFileSync(join(dir, "produksi.json"), JSON.stringify(prod));
    added = [];
    let msg = "";
    try { await gen([{ prompt: "a", tier: "draft" }, { prompt: "b", tier: "final" }]); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("Scene 2") && msg.includes("wajib shot") && added.length === 0, "scene ditolak -> tak ada job sama sekali (gagal cepat)");
    msg = "";
    try { await gen([{ prompt: "a", tier: "final", shot: "S03" }]); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("G2") && added.length === 0, "keyframe belum lulus -> ditolak");
    await gen([{ prompt: "a", tier: "draft" }, { prompt: "b", type: "image" }]);
    assert(added.length === 2 && !added.some((p) => "shot" in p || "force" in p), "draft & gambar lolos tanpa shot");
    added = [];
    const out = (await gen([{ prompt: "c", tier: "final", shot: "S01", force: "uji sudut" }])) as any;
    assert(added[0].shot === "S01" && added[0].force === "uji sudut", "shot/force dibawa ke params job");
    assert(out.jobs[0].note.includes("force: uji sudut"), "alasan force dikembalikan di catatan job");
    assert(rd(join(dir, "produksi-log.jsonl"), "utf8").includes('"force":"uji sudut"'), "force dicatat di log");
    assert(spentCredits(dir) === 0, "catatan force (tanpa file) tak menghabiskan anggaran");
    // 3. logDone: one line per video, counted once per job; retry of the same job id is not double-counted
    const job = { id: "jd1", status: "done", params: { ...added[0] }, files: [], attempts: 1, credits: 24, createdAt: "" } as Job;
    logDone(job, [join(dir, "scene-07.mp4"), join(dir, "scene-07.jpeg")]);
    logDone(job, [join(dir, "scene-07.mp4")]);
    assert(spentCredits(dir) === 24 && latestClip(dir, "S01") === "scene-07.mp4", "log setelah done: 24 kredit, sekali per job");
    // 4. no-quote tools: estimate against budget (48 - 24 = 24 left)
    added = [];
    msg = "";
    try { await core.edit({ project: "kopi-pagi", asset: "kopi-pagi-scene-07", prompt: "rain", acknowledge_cost: true } as any); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("Anggaran project habis") && msg.includes("sisa 24") && msg.includes("perkiraan 50") && added.length === 0, `edit melebihi sisa -> ditolak sebelum antre (${msg})`);
    await core.continue_shot({ project: "kopi-pagi", from_asset: "kopi-pagi-scene-07", prompt: "he walks out", aspect_ratio: "9:16", mode: "exact", acknowledge_cost: true, force: true } as any);
    assert(added.length === 1 && added[0].estimate === 24, "continue = 24 <= sisa 24 -> diantre dengan estimate");
    const contParams = added[0];
    const added0 = () => contParams;
    const ej = { id: "je1", status: "done", params: added[0], files: [], attempts: 1, createdAt: "" } as Job;
    logDone(ej, [join(dir, "shot-01.mp4")]);
    assert(spentCredits(dir) === 48 && ej.note!.includes("saldo tak terbaca"), "saldo tak terbaca -> perkiraan dicatat");
    const mj = { id: "je2", status: "done", params: { ...added[0] }, files: [], attempts: 1, credits: 30, createdAt: "" } as Job;
    logDone(mj, [join(dir, "shot-02.mp4")]);
    const last = JSON.parse(rd(join(dir, "produksi-log.jsonl"), "utf8").trim().split("\n").pop()!);
    assert(last.estimate === true && last.quote === 24 && last.credits === 24 && last.measured === 30 && mj.note!.includes("terukur dari saldo"), "anggaran = perkiraan; selisih saldo di measured, berlabel");
    added = [];
    msg = "";
    try { await core.agent({ project: "kopi-pagi", scenes: ["a"], aspect_ratio: "9:16" } as any); } catch (e) { msg = (e as Error).message; }
    assert(msg === "Mode produksi: pakai flow_generate type image (gratis, 0 kredit); mode agen tidak menampilkan harga." && added.length === 0, `agent images ditolak di mode produksi (${msg})`);
    // estimate 20, measured -500 / +1380 -> budget charged 20 only
    const before = spentCredits(dir);
    const p20 = { ...added0(), estimate: 20 };
    logDone({ id: "jm1", status: "done", params: p20, files: [], attempts: 1, credits: -500, createdAt: "" } as Job, [join(dir, "edit-01.mp4")]);
    logDone({ id: "jm1", status: "done", params: p20, files: [], attempts: 1, credits: 1380, createdAt: "" } as Job, [join(dir, "edit-01.mp4")]);
    const ml = rd(join(dir, "produksi-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.job === "jm1");
    assert(spentCredits(dir) - before === 20 && ml[0].measured === -500 && ml[1].measured === 1380 && ml.every((e) => e.credits === 20), "edit: anggaran = perkiraan 20, saldo di kolom measured");
    // 4b. frame references shot:/crop: (validated at generate(), no job when refused)
    added = [];
    msg = "";
    try { await gen([{ prompt: "d", tier: "final", shot: "S02", first_frame: "shot:S02@4.2", last_frame: "crop:1.10" }]); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("S02 belum punya klip; jalankan setelah klip induk dipilih") && added.length === 0, `shot: tanpa klip induk -> ditolak (${msg})`);
    writeFileSync(join(dir, "scene-07.mp4"), "");
    await gen([{ prompt: "d", tier: "final", shot: "S02", first_frame: "shot:S01@4.2", last_frame: "crop:1.10", crop_center: [0.4, 0.3] }]);
    assert(added.length === 1 && added[0].first_frame === "shot:S01@4.2" && JSON.stringify(added[0].crop_center) === "[0.4,0.3]", "pasangan turunan: G2 ditunda, rujukan + crop_center dibawa ke job");
    // produksi.json edited between queueing and running (target shot loses its face refs) -> job fails at run time,
    // before Flow: the real worker runs with runGeneration stubbed.
    const queued = added[0];
    const realQueue = new LocalCore() as any;
    const runner = realQueue.queue.runner as (j: Job) => Promise<string[]>;
    let flowCalls = 0;
    const realGen = runners.generation;
    runners.generation = async () => { flowCalls++; return []; };
    writeFileSync(join(dir, "produksi.json"), JSON.stringify({ ...prod, shots: prod.shots.map((x: any) => (x.id === "S02" ? { ...x, expression: undefined } : x)) }));
    msg = "";
    try { await runner({ id: "jr1", status: "running", params: { ...queued }, files: [], attempts: 1, createdAt: "" } as Job); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("face_refs") && flowCalls === 0, `face_refs dihapus setelah antre -> job gagal sebelum Flow (${msg}, flow ${flowCalls}x)`);
    // real clip + passing face (stubbed scorer): a lint error introduced after queueing is caught by the re-run gate;
    // with a clean produksi.json the same job reaches the (stubbed) Flow run exactly once.
    const { execFileSync } = await import("node:child_process");
    const { setFaceScorer } = await import("./produksi.js");
    execFileSync("nice", ["-n", "10", process.env.FLOW_MCP_FFMPEG ?? "ffmpeg", "-v", "error", "-y", "-threads", "4", "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=24", "-pix_fmt", "yuv420p", join(dir, "scene-07.mp4")]);
    setFaceScorer(async () => 0.9);
    writeFileSync(join(dir, "produksi.json"), JSON.stringify({ ...prod, shots: prod.shots.map((x: any) => (x.id === "S02" ? { ...x, angle: "low-angel" } : x)) }));
    msg = "";
    try { await runner({ id: "jr2", status: "running", params: { ...queued }, files: [], attempts: 1, createdAt: "" } as Job); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("Gerbang saat job jalan") && msg.includes("G1") && flowCalls === 0, `gerbang diulang saat jalan menolak (${msg})`);
    writeFileSync(join(dir, "produksi.json"), JSON.stringify(prod));
    rmSync(join(dir, "qa.json"), { force: true });
    const okJob = { id: "jr3", status: "running", params: { ...queued }, files: [], attempts: 1, createdAt: "" } as Job;
    await runner(okJob);
    assert(flowCalls === 1 && okJob.params.first_frame!.includes("frame/turunan") && okJob.params.first_frame!.includes("-jr3"), `pasangan lulus -> Flow dipanggil sekali dengan frame turunan (${okJob.params.first_frame})`);
    setFaceScorer(undefined);
    runners.generation = realGen;
    added = [];
    msg = "";
    try { await gen([{ prompt: "d", tier: "final" }], "proyek-lain-2").then(() => gen([{ prompt: "e", first_frame: "shot:S01@1" }], "proyek-lain-2")); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("produksi.json") && added.length === 1, `project tanpa produksi.json: shot: ditolak jelas (${msg})`);
    // 5. broken produksi.json: refused, file named, no job; another project is unaffected
    writeFileSync(join(dir, "produksi.json"), "{ rusak");
    added = [];
    msg = "";
    try { await gen([{ prompt: "a", type: "image" }]); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes(join(dir, "produksi.json")) && added.length === 0, "produksi.json rusak -> ditolak menyebut berkas");
    await gen([{ prompt: "a", tier: "final" }], "proyek-lain");
    assert(added.length === 1, "project lain tak terganggu");
    console.log("core (anak) ok");
  }
}
