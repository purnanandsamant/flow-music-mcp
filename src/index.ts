#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FLOW_MUSIC_URL, getFlowMusicPage, PROFILE_DIR } from "./chrome.js";
import {
  generateStoryboardVideosInFlowMusic,
  getFlowMusicStatus,
  interactWithFlowMusicPage,
  PLAYBOOK,
  startNewFlowMusicSession,
} from "./flow-music.js";
import {
  DEFAULT_GEMINI_IMAGE_MODELS,
  generateCharacterImageWithGemini,
  generateSceneImageWithGemini,
  getGeminiApiKey,
  identifyLyricsAndTimestampsWithGemini,
  KEY_FILE,
  saveAndVerifyGeminiApiKey,
  saveRuntimeConfig,
} from "./gemini.js";
import {
  connectProjectFolder,
  formatShotId,
  getActiveFolderPath,
  loadProject,
  parseTimestampToSeconds,
  renderStoryboardMarkdown,
  saveProject,
} from "./storyboard.js";
import {
  CharacterOutfitSchema,
  EnvironmentSettingSchema,
  FrameModeSchema,
  type SceneShot,
} from "./types.js";

try {
  setDefaultResultOrder("ipv4first");
} catch {
  // Ignore
}

const server = new McpServer({
  name: "flow-music-mcp",
  version: "1.1.0",
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const reply = async (work: Promise<unknown>): Promise<ToolResult> => {
  try {
    const data = await work;
    return {
      content: [
        {
          type: "text",
          text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: err instanceof Error ? err.message : String(err),
              important_rule:
                "Do NOT run background shell searches on the filesystem or ask the user to restart Claude. Use the MCP tools directly.",
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
};

const PATIENCE_MS = Number(process.env.FLOW_MUSIC_PATIENCE_MS ?? 45_000);

interface BackgroundTask {
  task_id: string;
  tool: string;
  started_at: string;
  status: "running" | "done" | "failed";
  result?: unknown;
  error?: string;
}

const tasks = new Map<string, BackgroundTask>();

async function runWithPatience(toolName: string, work: Promise<unknown>): Promise<unknown> {
  const task: BackgroundTask = {
    task_id: `task-${randomUUID().slice(0, 8)}`,
    tool: toolName,
    started_at: new Date().toISOString(),
    status: "running",
  };

  const settled = work.then(
    (res) => {
      task.status = "done";
      task.result = res;
    },
    (err) => {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
    }
  );

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), PATIENCE_MS);
  });

  const winner = await Promise.race([settled.then(() => "settled" as const), timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (winner === "settled") {
    return await work;
  }

  tasks.set(task.task_id, task);
  return {
    still_working: true,
    task_id: task.task_id,
    note: `${toolName} is still running in the background. Call 'flow_music_wait' with task_id="${task.task_id}" to collect the result. Do NOT re-run ${toolName}.`,
  };
}

// ============================================================================
// PHASE 1: CONNECT PROJECT FOLDER & MP3 + GEMINI LYRICS & TIMESTAMPS
// ============================================================================

server.registerTool(
  "project_connect",
  {
    title: "Connect to MP3 Project Folder",
    description:
      "Step 0: Connect to a local folder where an MP3 (or WAV/M4A) is placed. Initializes or loads storyboard.json, STORYBOARD.md, and creates characters/, scenes/, and videos/ subfolders. Never search the filesystem for config files; call this tool directly.",
    inputSchema: {
      folder_path: z.string().describe("Absolute path to the folder containing the MP3 file"),
      mp3_filename: z
        .string()
        .optional()
        .describe("Optional specific audio filename if multiple audio files exist in the folder"),
      project_name: z.string().optional().describe("Optional display title for the music video project"),
      style_anchor: z
        .string()
        .optional()
        .describe("Optional Mandatory Style Anchor prepended to all character, keyframe, and video prompts"),
      aspect_ratio: z
        .enum(["16:9", "9:16", "1:1", "4:3", "3:4"])
        .optional()
        .describe("Target aspect ratio (default: 16:9)"),
    },
  },
  (args) =>
    reply(
      (async () => {
        const res = connectProjectFolder(args);
        return {
          message: res.is_existing
            ? `Loaded existing storyboard project '${res.project.project_name}' from ${res.project.folder_path}`
            : `Initialized new storyboard project '${res.project.project_name}' in ${res.project.folder_path}`,
          mp3_file: res.project.mp3_file,
          mp3_duration_seconds: res.project.mp3_duration_seconds,
          available_audio_files: res.available_audio_files,
          gemini_api_key_configured: Boolean(getGeminiApiKey()),
          gemini_key_file: KEY_FILE,
          lyrics_segments_count: res.project.lyrics.length,
          characters_count: res.project.characters.length,
          scenes_count: res.project.scenes.length,
          storyboard_files: {
            json: join(res.project.folder_path, "storyboard.json"),
            markdown: join(res.project.folder_path, "STORYBOARD.md"),
          },
          playbook: PLAYBOOK,
          next_step:
            res.project.lyrics.length === 0
              ? "Call 'music_identify_lyrics' to analyze the MP3 with Gemini and extract lyrics + timestamps."
              : "Call 'storyboard_get' to inspect current scenes and characters.",
        };
      })()
    )
);

server.registerTool(
  "gemini_set_api_key",
  {
    title: "Set Gemini API Key & Optional Model Preferences",
    description:
      "Save a Google AI Studio / Gemini API key to ~/.flow-music-mcp/gemini-key (no restart needed). IMPORTANT: Valid Google AI Studio keys start with EITHER 'AIza' (older format) OR 'AQ.' (newer 2026 format). Accept 'AQ.' keys immediately without questioning the user.",
    inputSchema: {
      api_key: z
        .string()
        .describe("Your Gemini API key from Google AI Studio (starts with 'AIza...' or 'AQ....')"),
      gemini_image_model: z
        .string()
        .optional()
        .describe(
          "Optional preferred Gemini image model (e.g. 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-2.5-flash-image')"
        ),
      prefer_browser_image_generation: z
        .boolean()
        .optional()
        .describe(
          "If true, generates character and scene images directly through the signed-in Google Flow Music Chrome window instead of the REST API"
        ),
    },
  },
  (args) =>
    reply(
      (async () => {
        const res = await saveAndVerifyGeminiApiKey(args.api_key);
        if (
          args.gemini_image_model !== undefined ||
          args.prefer_browser_image_generation !== undefined
        ) {
          saveRuntimeConfig({
            gemini_image_model: args.gemini_image_model,
            prefer_browser_image_generation: args.prefer_browser_image_generation,
          });
        }
        return {
          configured: true,
          ...res,
          note: "Gemini API key saved and active immediately (no restart required).",
        };
      })()
    )
);

server.registerTool(
  "music_identify_lyrics",
  {
    title: "Identify Lyrics & Timestamps from MP3 (Gemini Audio)",
    description:
      "Step 1 & 2: Uses Gemini multimodal audio analysis on the MP3 in the folder to identify exact lyrics, MM:SS timestamps, song sections (Intro, Verse, Chorus, Bridge, Outro), mood/BPM, and optionally drafts initial sub-10-second storyboard scenes with frame_mode ('generate_start_frame' vs 'use_previous_last_frame'). Automatically connects to folder_path if not connected yet.",
    inputSchema: {
      folder_path: z
        .string()
        .optional()
        .describe("Path to the folder containing the MP3 file (optional if already connected)"),
      auto_draft_scenes: z
        .boolean()
        .default(true)
        .describe(
          "If true, Gemini also proposes an initial sub-10-second scene breakdown, characters, and settings"
        ),
      preferred_shot_duration_seconds: z
        .number()
        .min(4)
        .max(10)
        .default(8)
        .describe("Preferred duration in seconds for drafted shots (4 to 10 seconds, default 8)"),
      creative_direction: z
        .string()
        .optional()
        .describe("Optional user creative concept, visual story idea, or character notes to guide scene drafting"),
    },
  },
  (args) =>
    reply(
      runWithPatience(
        "music_identify_lyrics",
        (async () => {
          const project = loadProject(args.folder_path);
          const result = await identifyLyricsAndTimestampsWithGemini(project, {
            auto_draft_scenes: args.auto_draft_scenes,
            preferred_shot_duration_seconds: args.preferred_shot_duration_seconds,
            creative_direction: args.creative_direction,
          });
          saveProject(project);
          return {
            song_metadata: result.song_metadata,
            model_used: result.model_used,
            lyrics_count: result.lyrics.length,
            lyrics: result.lyrics,
            drafted_characters: project.characters,
            drafted_environments: project.environments,
            drafted_scenes_count: result.drafted_scenes_count,
            scenes_preview: project.scenes.map((s) => ({
              shot_number: s.shot_number,
              timestamp: `${s.start_time}-${s.end_time}`,
              section: s.section,
              frame_mode: s.frame_mode,
              camera_and_action: s.camera_and_action,
              keyframe_specification: s.keyframe_specification,
              lyric_line: s.lyric_line,
            })),
            markdown_saved_to: join(project.folder_path, "STORYBOARD.md"),
            next_step:
              "Present the identified lyrics, timestamps, and drafted scenes to the user so they can review or edit scenes before generating character & scene images.",
          };
        })()
      )
    )
);

// ============================================================================
// PHASE 2 & 3: STORYBOARD & SCENE CREATION / EDITING
// ============================================================================

server.registerTool(
  "storyboard_get",
  {
    title: "Get Current Storyboard & Sync Markdown Edits",
    description:
      "Reads the current storyboard (lyrics, production bible, characters, environments, and scenes). Automatically syncs any manual edits the user made directly in STORYBOARD.md.",
    inputSchema: {
      folder_path: z.string().optional().describe("Project folder path (optional if already connected)"),
    },
  },
  ({ folder_path }) =>
    reply(
      (async () => {
        const project = loadProject(folder_path);
        return project;
      })()
    )
);

server.registerTool(
  "storyboard_set_production_bible",
  {
    title: "Set Visual Production Bible (Style Anchor & Environments)",
    description:
      "Update the Mandatory Style Anchor, song metadata, aspect ratio, and Environment/Lighting Settings (e.g. Setting A, Setting B, Setting C with Kelvin lighting and hex palettes).",
    inputSchema: {
      folder_path: z.string().optional(),
      style_anchor: z
        .string()
        .optional()
        .describe("Mandatory Style Anchor prepended to every shot generation"),
      aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional(),
      overall_theme: z.string().optional(),
      environments: z
        .array(EnvironmentSettingSchema)
        .optional()
        .describe("List of environmental & lighting direction settings across song phases"),
    },
  },
  (args) =>
    reply(
      (async () => {
        const project = loadProject(args.folder_path);
        if (args.style_anchor) project.style_anchor = args.style_anchor;
        if (args.aspect_ratio) project.aspect_ratio = args.aspect_ratio;
        if (args.overall_theme) project.song_metadata.overall_theme = args.overall_theme;
        if (args.environments) project.environments = args.environments;
        saveProject(project);
        return {
          updated: true,
          style_anchor: project.style_anchor,
          aspect_ratio: project.aspect_ratio,
          environments: project.environments,
          scenes_recompiled: project.scenes.length,
        };
      })()
    )
);

server.registerTool(
  "storyboard_upsert_character",
  {
    title: "Add or Update a Character Model Sheet Spec",
    description:
      "Step 4 prep: Create or update a character in the Visual Production Bible (including proportions, hair/eyes, mandatory Character Anchor string, signature props, and outfits with hex color codes).",
    inputSchema: {
      folder_path: z.string().optional(),
      id: z.string().describe("Character slug ID, e.g. 'leo'"),
      name: z.string().describe("Display name, e.g. 'Leo (Age 5)'"),
      proportions: z.string().describe("Build and head-to-body ratio"),
      hair_and_eyes: z.string().describe("Hair and eye details"),
      anchor_prompt: z
        .string()
        .describe("Concise Character Anchor string prepended to every shot with this character"),
      signature_props: z.array(z.string()).default([]),
      outfits: z.array(CharacterOutfitSchema).default([]),
    },
  },
  (args) =>
    reply(
      (async () => {
        const project = loadProject(args.folder_path);
        const idx = project.characters.findIndex(
          (c) => c.id.toLowerCase() === args.id.toLowerCase()
        );
        const existing = idx >= 0 ? project.characters[idx] : undefined;

        const mergedOutfits = args.outfits.map((o) => {
          const prevOutfit = existing?.outfits.find((po) => po.id === o.id);
          return {
            ...o,
            image_path: o.image_path ?? prevOutfit?.image_path,
          };
        });

        const spec = {
          id: args.id,
          name: args.name,
          proportions: args.proportions,
          hair_and_eyes: args.hair_and_eyes,
          anchor_prompt: args.anchor_prompt,
          signature_props: args.signature_props,
          outfits: mergedOutfits,
          primary_image_path: existing?.primary_image_path,
        };

        if (idx >= 0) {
          project.characters[idx] = spec;
        } else {
          project.characters.push(spec);
        }

        saveProject(project);
        return {
          message: `Saved character '${spec.name}' (${spec.id}) and recompiled scene prompts.`,
          character: spec,
        };
      })()
    )
);

const SceneInputSchema = z.object({
  shot_number: z.number().int().positive(),
  section: z.string().describe("e.g. Intro, Verse 1A, Chorus 1"),
  start_time: z.string().describe("MM:SS, e.g. 0:00"),
  end_time: z.string().describe("MM:SS, e.g. 0:08"),
  lyric_line: z.string().default(""),
  setting_id: z.string().optional(),
  character_ids: z.array(z.string()).default([]),
  outfit_id: z.string().optional(),
  camera_and_action: z.string().describe("Camera angle, movement, and visual action"),
  frame_mode: FrameModeSchema.describe(
    "'generate_start_frame' to generate a starting keyframe image with Gemini, or 'use_previous_last_frame' to instruct Google Flow Music to use the last frame from the previous scene"
  ),
  end_frame_shot_id: z.string().optional(),
  keyframe_specification: z
    .string()
    .describe("Visual keyframe prompt specification (can use [Character Anchor])"),
});

server.registerTool(
  "storyboard_set_scenes",
  {
    title: "Create or Replace All Storyboard Scenes",
    description:
      "Step 2: Define the complete list of sub-10-second timestamped storyboard scenes, specifying for each scene whether to generate a starting frame ('generate_start_frame') or use the last frame from the previous scene ('use_previous_last_frame').",
    inputSchema: {
      folder_path: z.string().optional(),
      scenes: z.array(SceneInputSchema).min(1),
    },
  },
  (args) =>
    reply(
      (async () => {
        const project = loadProject(args.folder_path);
        project.scenes = args.scenes.map((s, idx) => {
          const shotNum = idx + 1;
          const startSec = parseTimestampToSeconds(s.start_time);
          const endSec = parseTimestampToSeconds(s.end_time);
          const dur = endSec > startSec ? Math.min(10, Math.max(2, endSec - startSec)) : 8;
          const mode =
            s.frame_mode === "use_previous_last_frame" && shotNum > 1
              ? "use_previous_last_frame"
              : "generate_start_frame";
          return {
            shot_number: shotNum,
            shot_id: formatShotId(shotNum),
            section: s.section,
            start_time: s.start_time,
            end_time: s.end_time,
            duration_seconds: dur,
            lyric_line: s.lyric_line,
            setting_id: s.setting_id,
            character_ids: s.character_ids,
            outfit_id: s.outfit_id,
            camera_and_action: s.camera_and_action,
            frame_mode: mode,
            end_frame_shot_id: s.end_frame_shot_id,
            keyframe_specification: s.keyframe_specification,
            image_status: mode === "use_previous_last_frame" ? "uses_previous_last_frame" : "pending",
            video_status: "pending",
          };
        });
        saveProject(project);
        return {
          scenes_count: project.scenes.length,
          start_frame_scenes: project.scenes.filter((s) => s.frame_mode === "generate_start_frame").length,
          continue_last_frame_scenes: project.scenes.filter(
            (s) => s.frame_mode === "use_previous_last_frame"
          ).length,
          scenes: project.scenes,
          markdown_file: join(project.folder_path, "STORYBOARD.md"),
        };
      })()
    )
);

server.registerTool(
  "storyboard_edit_scene",
  {
    title: "Edit, Insert, or Delete a Storyboard Scene",
    description:
      "Step 3: Allows the user to edit any scene's timestamps, section, camera_and_action, frame_mode ('generate_start_frame' vs 'use_previous_last_frame'), keyframe_specification, character/outfit references, or insert/delete a shot.",
    inputSchema: {
      folder_path: z.string().optional(),
      operation: z.enum(["update", "insert", "delete"]).default("update"),
      shot_number: z.number().int().positive().describe("Target 1-based shot number"),
      updates: z
        .object({
          section: z.string().optional(),
          start_time: z.string().optional(),
          end_time: z.string().optional(),
          lyric_line: z.string().optional(),
          setting_id: z.string().optional(),
          character_ids: z.array(z.string()).optional(),
          outfit_id: z.string().optional(),
          camera_and_action: z.string().optional(),
          frame_mode: FrameModeSchema.optional(),
          end_frame_shot_id: z.string().optional(),
          keyframe_specification: z.string().optional(),
        })
        .optional(),
    },
  },
  (args) =>
    reply(
      (async () => {
        const project = loadProject(args.folder_path);

        if (args.operation === "delete") {
          project.scenes = project.scenes.filter((s) => s.shot_number !== args.shot_number);
          saveProject(project);
          return {
            deleted_shot: args.shot_number,
            remaining_scenes: project.scenes.length,
          };
        }

        if (args.operation === "insert") {
          const u = args.updates ?? {};
          const startTime = u.start_time || "0:00";
          const endTime = u.end_time || "0:08";
          const mode = u.frame_mode || "generate_start_frame";
          const newScene: SceneShot = {
            shot_number: args.shot_number,
            shot_id: formatShotId(args.shot_number),
            section: u.section || `Shot ${args.shot_number}`,
            start_time: startTime,
            end_time: endTime,
            duration_seconds: Math.max(
              2,
              Math.min(10, parseTimestampToSeconds(endTime) - parseTimestampToSeconds(startTime) || 8)
            ),
            lyric_line: u.lyric_line || "",
            setting_id: u.setting_id,
            character_ids: u.character_ids ?? [],
            outfit_id: u.outfit_id,
            camera_and_action: u.camera_and_action || "Medium shot",
            frame_mode: mode,
            end_frame_shot_id: u.end_frame_shot_id,
            keyframe_specification: u.keyframe_specification || "",
            image_status: mode === "use_previous_last_frame" ? "uses_previous_last_frame" : "pending",
            video_status: "pending",
          };
          const insertIdx = Math.min(project.scenes.length, Math.max(0, args.shot_number - 1));
          project.scenes.splice(insertIdx, 0, newScene);
          saveProject(project);
          return {
            inserted_at: args.shot_number,
            scene: project.scenes[insertIdx],
            total_scenes: project.scenes.length,
          };
        }

        const scene = project.scenes.find((s) => s.shot_number === args.shot_number);
        if (!scene) {
          throw new Error(`Shot ${args.shot_number} not found.`);
        }
        const u = args.updates ?? {};
        if (u.section !== undefined) scene.section = u.section;
        if (u.start_time !== undefined) scene.start_time = u.start_time;
        if (u.end_time !== undefined) scene.end_time = u.end_time;
        if (u.lyric_line !== undefined) scene.lyric_line = u.lyric_line;
        if (u.setting_id !== undefined) scene.setting_id = u.setting_id;
        if (u.character_ids !== undefined) scene.character_ids = u.character_ids;
        if (u.outfit_id !== undefined) scene.outfit_id = u.outfit_id;
        if (u.camera_and_action !== undefined) scene.camera_and_action = u.camera_and_action;
        if (u.frame_mode !== undefined) {
          scene.frame_mode = u.frame_mode;
          scene.image_status =
            u.frame_mode === "use_previous_last_frame" ? "uses_previous_last_frame" : "pending";
        }
        if (u.end_frame_shot_id !== undefined) scene.end_frame_shot_id = u.end_frame_shot_id;
        if (u.keyframe_specification !== undefined) {
          scene.keyframe_specification = u.keyframe_specification;
        }

        saveProject(project);
        const updated = project.scenes.find((s) => s.shot_number === args.shot_number);
        return {
          updated: true,
          scene: updated,
        };
      })()
    )
);

server.registerTool(
  "calculate_scene_frames",
  {
    title: "Calculate Scene Frame Count",
    description:
      "Calculate exact frame count for an animation shot given duration in seconds and FPS (from MCP Blueprint Reference).",
    inputSchema: {
      duration_seconds: z.number().positive(),
      fps: z.number().int().positive().default(24),
    },
  },
  ({ duration_seconds, fps }) =>
    reply(
      Promise.resolve({
        duration_seconds,
        fps,
        exact_frames: Math.round(duration_seconds * fps),
      })
    )
);

// ============================================================================
// PHASE 4: GEMINI CHARACTER & SCENE KEYFRAME IMAGE GENERATION
// ============================================================================

server.registerTool(
  "gemini_generate_character_image",
  {
    title: "Generate Character Model Sheet Image with Gemini",
    description:
      `Step 4a: Generate a character reference sheet (or specific outfit sheet) using Gemini Image Generation (defaults: ${DEFAULT_GEMINI_IMAGE_MODELS.slice(0, 3).join(", ")}; automatically falls back to the signed-in Google Flow Music Chrome session if the API key is on the Free Tier) and save it to <folder>/characters/. No app restart is ever required.`,
    inputSchema: {
      folder_path: z.string().optional(),
      character_id: z.string().describe("Character ID, e.g. 'leo'"),
      outfit_id: z.string().optional().describe("Optional outfit ID, e.g. 'indoor_cozy' or 'outdoor_rain'"),
      custom_prompt_override: z
        .string()
        .optional()
        .describe("Optional full prompt override if the user wants specific adjustments"),
      reference_image_path: z
        .string()
        .optional()
        .describe("Optional path to an existing reference image to lock appearance"),
      image_model: z
        .string()
        .optional()
        .describe(
          "Optional model override (e.g. 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-2.5-flash-image')"
        ),
    },
  },
  (args) =>
    reply(
      runWithPatience(
        "gemini_generate_character_image",
        (async () => {
          const project = loadProject(args.folder_path);
          const res = await generateCharacterImageWithGemini(project, args);
          saveProject(project);
          return res;
        })()
      )
    )
);

server.registerTool(
  "gemini_generate_scene_images",
  {
    title: "Generate Scene Keyframe Images with Gemini",
    description:
      "Step 4b: Generate starting frame images (<folder>/scenes/shot-NN.png) using Gemini Image Generation for all (or selected) storyboard scenes with frame_mode='generate_start_frame'. Automatically passes the locked character reference image(s) from <folder>/characters/ into Gemini (and falls back to the signed-in Google Flow Music Chrome session if the API key is on the Free Tier).",
    inputSchema: {
      folder_path: z.string().optional(),
      shot_numbers: z
        .array(z.number().int().positive())
        .optional()
        .describe("Specific shot numbers to generate (omit to generate all pending 'generate_start_frame' shots)"),
      custom_prompt_override: z
        .string()
        .optional()
        .describe("Optional custom prompt override (only used when generating a single shot_number)"),
      force_even_if_uses_last_frame: z
        .boolean()
        .default(false)
        .describe("If true, generates a static image even if the shot's frame_mode is 'use_previous_last_frame'"),
      include_previous_scene_image_as_reference: z
        .boolean()
        .default(false)
        .describe("If true, also attaches the previous shot's image as a visual continuity reference"),
      image_model: z
        .string()
        .optional()
        .describe(
          "Optional model override (e.g. 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-2.5-flash-image')"
        ),
    },
  },
  (args) =>
    reply(
      runWithPatience(
        "gemini_generate_scene_images",
        (async () => {
          const project = loadProject(args.folder_path);
          const targets = args.shot_numbers?.length
            ? project.scenes.filter((s) => args.shot_numbers!.includes(s.shot_number))
            : project.scenes.filter(
                (s) => s.frame_mode === "generate_start_frame" || args.force_even_if_uses_last_frame
              );

          const results = [];
          for (const scene of targets) {
            const r = await generateSceneImageWithGemini(project, {
              shot_number: scene.shot_number,
              custom_prompt_override:
                targets.length === 1 ? args.custom_prompt_override : undefined,
              force_even_if_uses_last_frame: args.force_even_if_uses_last_frame,
              include_previous_scene_image_as_reference:
                args.include_previous_scene_image_as_reference,
              image_model: args.image_model,
            });
            saveProject(project);
            results.push(r);
          }

          return {
            generated_count: results.filter((r) => !r.skipped).length,
            skipped_last_frame_count: results.filter((r) => r.skipped).length,
            results,
            scenes_dir: join(project.folder_path, "scenes"),
          };
        })()
      )
    )
);

// ============================================================================
// PHASE 5: GOOGLE FLOW MUSIC (flowmusic.app) SESSION & VIDEO GENERATION
// ============================================================================

server.registerTool(
  "flow_music_login",
  {
    title: "Open Google Flow Music Chrome Window for Login",
    description:
      "Opens the dedicated Chrome profile at https://www.flowmusic.app/ so the user can sign in with their Google Account and enable Google One AI benefits.",
    inputSchema: {},
  },
  () =>
    reply(
      (async () => {
        const page = await getFlowMusicPage();
        return {
          opened: true,
          url: page.url(),
          flow_music_home: FLOW_MUSIC_URL,
          chrome_profile_dir: PROFILE_DIR,
          instructions:
            "Sign in to Google Flow Music in the opened Chrome window (Click 'Login -> Continue with Google', and check the box for Google One benefits). Leave the window open.",
        };
      })()
    )
);

server.registerTool(
  "flow_music_status",
  {
    title: "Check Google Flow Music Session & Login Status",
    description:
      "Checks the dedicated Google Flow Music Chrome window (signed in status, current URL, visible controls, credit/plan badge, Gemini API key status, and active background tasks) and returns the PLAYBOOK.",
    inputSchema: {},
  },
  () =>
    reply(
      (async () => {
        const status = await getFlowMusicStatus();
        const runningTasks = Array.from(tasks.values()).filter((t) => t.status === "running");
        return {
          ...status,
          running_background_tasks: runningTasks,
        };
      })()
    )
);

server.registerTool(
  "flow_music_new_session",
  {
    title: "Start a New Google Flow Music Session / Music Video",
    description:
      "Step 5a: Initiates a new Session or Music Video in Google Flow Music (https://www.flowmusic.app/), attaches the project's MP3 audio ('Upload audio file'), and optionally selects the video generation model ('Chat settings -> Video Generation').",
    inputSchema: {
      folder_path: z.string().optional(),
      workflow_mode: z
        .enum(["music_video", "session", "project"])
        .default("session")
        .describe("Open a new Producer/Video 'session' (default), 'music_video', or a new 'project'"),
      attach_mp3: z
        .boolean()
        .default(true)
        .describe("Automatically attach the folder's MP3 file via 'Upload audio file'"),
      video_model: z
        .string()
        .optional()
        .describe("Optional video model name to select under Chat settings -> Video Generation"),
    },
  },
  (args) =>
    reply(
      runWithPatience(
        "flow_music_new_session",
        (async () => {
          const project = loadProject(args.folder_path);
          return await startNewFlowMusicSession(project, args);
        })()
      )
    )
);

server.registerTool(
  "flow_music_generate_videos",
  {
    title: "Generate Storyboard Videos in Google Flow Music",
    description:
      "Step 5b: Works with Google Flow Music to initiate the storyboard and generate videos for all (or selected) scenes. For 'generate_start_frame' scenes, attaches the Gemini-generated scene image ('scenes/shot-NN.png'). For 'use_previous_last_frame' scenes, extracts the exact final frame from the previous scene's generated video and instructs Google Flow Music to continue seamlessly from that frame. Downloads finished MP4s to <folder>/videos/.",
    inputSchema: {
      folder_path: z.string().optional(),
      shot_numbers: z
        .array(z.number().int().positive())
        .optional()
        .describe("Specific shot numbers to generate (omit to run all storyboard shots in sequence)"),
      initiate_session_overview_first: z
        .boolean()
        .default(true)
        .describe(
          "Send the master Visual Production Bible & Storyboard overview to the session before generating clips"
        ),
      video_model: z.string().optional().describe("Optional video model to select before generating"),
      per_video_timeout_seconds: z
        .number()
        .int()
        .min(30)
        .max(600)
        .default(240)
        .describe("Max seconds to wait for each video clip to render and download"),
    },
  },
  (args) =>
    reply(
      runWithPatience(
        "flow_music_generate_videos",
        (async () => {
          const project = loadProject(args.folder_path);
          return await generateStoryboardVideosInFlowMusic(project, args);
        })()
      )
    )
);

server.registerTool(
  "flow_music_wait",
  {
    title: "Wait for Background Task Completion",
    description:
      "Waits up to 40 seconds for a running background task (returned when a Gemini batch or Google Flow Music video generation takes longer than 45 seconds) and returns its status or result.",
    inputSchema: {
      task_id: z.string().describe("The task_id returned by a previous tool call"),
      timeout_seconds: z.number().int().min(5).max(40).default(35),
    },
  },
  ({ task_id, timeout_seconds }) =>
    reply(
      (async () => {
        const task = tasks.get(task_id);
        if (!task) {
          return {
            task_id,
            status: "not_found",
            note: "No task found with that ID in this server process.",
          };
        }
        const deadline = Date.now() + timeout_seconds * 1000;
        while (Date.now() < deadline && task.status === "running") {
          await new Promise((r) => setTimeout(r, 1000));
        }
        return {
          task_id: task.task_id,
          tool: task.tool,
          started_at: task.started_at,
          status: task.status,
          finished: task.status !== "running",
          result: task.result,
          error: task.error,
        };
      })()
    )
);

server.registerTool(
  "flow_music_inspect_and_act",
  {
    title: "Inspect or Interact with Live Google Flow Music Page",
    description:
      "Inspects the live Google Flow Music DOM/buttons/inputs/videos, takes a screenshot, or performs a custom click, fill, audio upload, or image upload on https://www.flowmusic.app/.",
    inputSchema: {
      action: z
        .enum(["inspect", "navigate", "click", "fill", "upload_audio", "upload_image", "screenshot"])
        .describe("Action to perform on the Google Flow Music Chrome page"),
      target: z
        .string()
        .optional()
        .describe(
          "Button text/CSS selector (for click/fill), URL (for navigate), or file path (for upload_audio/upload_image)"
        ),
      value: z.string().optional().describe("Text to enter into the prompt/input (for fill)"),
      save_path: z.string().optional().describe("Optional output path for screenshot"),
    },
  },
  (args) => reply(interactWithFlowMusicPage(args))
);

// ============================================================================
// MCP RESOURCES & PROMPTS (Per MCP Blueprint PDF Part I)
// ============================================================================

server.registerResource(
  "character-lock",
  "config://studio/character-lock",
  {
    title: "Studio Character & Style Consistency Lock",
    description: "Read-only style & character consistency lock from the active storyboard project",
    mimeType: "text/plain",
  },
  async (uri) => {
    const folder = getActiveFolderPath();
    if (!folder || !existsSync(join(folder, "storyboard.json"))) {
      return {
        contents: [
          {
            uri: uri.href,
            text: "Default Style Anchor: Pixar-style 3D stylized animation, soft warm lighting, tactile textures, rich color saturation, 8k resolution, cinematic composition",
          },
        ],
      };
    }
    const project = loadProject(folder);
    const charSummary = project.characters
      .map((c) => `${c.name}: ${c.anchor_prompt}`)
      .join(" | ");
    return {
      contents: [
        {
          uri: uri.href,
          text: `Style Anchor: ${project.style_anchor}\nCharacters: ${charSummary || "None defined yet"}`,
        },
      ],
    };
  }
);

server.registerResource(
  "storyboard-markdown",
  "storyboard://current/markdown",
  {
    title: "Current Project STORYBOARD.md",
    description: "Live Markdown Storyboard Production Bible for the active MP3 project folder",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const folder = getActiveFolderPath();
    if (!folder) {
      return {
        contents: [{ uri: uri.href, text: "No project folder connected yet. Call project_connect first." }],
      };
    }
    const mdPath = join(folder, "STORYBOARD.md");
    const text = existsSync(mdPath)
      ? readFileSync(mdPath, "utf8")
      : renderStoryboardMarkdown(loadProject(folder));
    return {
      contents: [{ uri: uri.href, text }],
    };
  }
);

server.registerPrompt(
  "review_shot_prompt",
  {
    title: "Review Shot Prompt Against Character & Style Lock",
    description: "Check a shot prompt against character consistency and style anchor rules.",
    argsSchema: {
      shot_text: z.string().describe("The shot prompt text to verify"),
    },
  },
  ({ shot_text }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Verify this shot includes the Mandatory Character & Style Anchors, appropriate Kelvin lighting, hex color codes, and clear frame continuity mode ('generate_start_frame' vs 'use_previous_last_frame'):\n\n${shot_text}`,
        },
      },
    ],
  })
);

server.registerPrompt(
  "music_video_production_workflow",
  {
    title: "End-to-End Music Video Production Workflow",
    description:
      "Step-by-step guide for Claude to produce a music video from an MP3 folder using Gemini and Google Flow Music.",
    argsSchema: {
      folder_path: z.string().describe("Path to the folder containing the MP3 file"),
    },
  },
  ({ folder_path }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Let's produce a complete AI Music Video for the MP3 in "${folder_path}" following these exact phases:
1. Call 'project_connect' with folder_path="${folder_path}" and then 'music_identify_lyrics' so Gemini extracts the full lyrics, timestamps, and initial sub-10s scenes.
2. Show me the identified lyrics, timestamps, and proposed scenes (including whether each scene uses 'generate_start_frame' or 'use_previous_last_frame'). Pause so I can edit or approve the scenes.
3. Work with me to lock the Character Model Sheet(s) ('storyboard_upsert_character' + 'gemini_generate_character_image') and then generate all starting scene keyframe images ('gemini_generate_scene_images'). Pause so I can inspect the generated images in the scenes/ folder.
4. Once I approve all scene images, check 'flow_music_status', start a new session in Google Flow Music ('flow_music_new_session'), and generate all scene videos ('flow_music_generate_videos').`,
        },
      },
    ],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error in flow-music-mcp:", err);
  process.exit(1);
});
