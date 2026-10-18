import { z } from "zod";

export const FrameModeSchema = z.enum([
  "generate_start_frame",
  "use_previous_last_frame",
]);

export type FrameMode = z.infer<typeof FrameModeSchema>;

export const LyricSegmentSchema = z.object({
  id: z.string(),
  section: z.string().describe("Song section, e.g. Intro, Verse 1, Chorus 1, Bridge, Outro"),
  start_time: z.string().describe("Timestamp in MM:SS format, e.g. 0:00"),
  end_time: z.string().describe("Timestamp in MM:SS format, e.g. 0:08"),
  start_seconds: z.number(),
  end_seconds: z.number(),
  text: z.string().describe("Lyric text or instrumental description for this segment"),
  mood_notes: z.string().optional(),
});

export type LyricSegment = z.infer<typeof LyricSegmentSchema>;

export const CharacterOutfitSchema = z.object({
  id: z.string().describe("Outfit identifier, e.g. indoor_cozy or outdoor_rain"),
  name: z.string().describe("Human-readable outfit name, e.g. Outfit 2 (Outdoor Rain)"),
  time_range: z.string().optional().describe("Timestamp range where this outfit is used, e.g. 0:41-2:30"),
  description: z.string().describe("Detailed clothing, texture, and hex color specification"),
  hex_palette: z.array(z.string()).default([]).describe("Key hex colors, e.g. ['#FFD700', '#D2143A']"),
  image_path: z.string().optional().describe("Local path to generated character outfit sheet PNG"),
});

export type CharacterOutfit = z.infer<typeof CharacterOutfitSchema>;

export const CharacterSpecSchema = z.object({
  id: z.string().describe("Character slug ID, e.g. leo"),
  name: z.string().describe("Character display name, e.g. Leo (Age 5)"),
  proportions: z.string().describe("Physical build and head-to-body ratio"),
  hair_and_eyes: z.string().describe("Hair color, style, eye shape/color, facial features"),
  signature_props: z.array(z.string()).default([]).describe("Recurring props and visual anchors"),
  anchor_prompt: z.string().describe(
    "Concise mandatory Character Anchor string prepended to every shot containing this character"
  ),
  outfits: z.array(CharacterOutfitSchema).default([]),
  primary_image_path: z.string().optional().describe("Default reference image path for this character"),
});

export type CharacterSpec = z.infer<typeof CharacterSpecSchema>;

export const EnvironmentSettingSchema = z.object({
  id: z.string().describe("Setting ID, e.g. setting_a"),
  name: z.string().describe("Setting name, e.g. Setting A - Indoor Window Nook"),
  time_range: z.string().optional().describe("Song timestamp range, e.g. 0:00-0:41"),
  description: z.string().describe("Detailed environment, architecture, weather, and lighting Kelvin notes"),
  dominant_palette: z.array(z.string()).default([]).describe("Dominant hex colors, e.g. ['#4A607A', '#FDF6E2']"),
  key_accents: z.array(z.string()).default([]).describe("Accent hex colors, e.g. ['#FFB347', '#8B5A2B']"),
  camera_style: z.string().optional().describe("Camera and lens treatment for this phase"),
});

export type EnvironmentSetting = z.infer<typeof EnvironmentSettingSchema>;

export const SceneShotSchema = z.object({
  shot_number: z.number().int().positive().describe("1-based sequential shot number"),
  shot_id: z.string().describe("Formatted ID such as shot-01"),
  section: z.string().describe("Song section label, e.g. Intro, Verse 1A, Chorus 1"),
  start_time: z.string().describe("Shot start timestamp MM:SS, e.g. 0:00"),
  end_time: z.string().describe("Shot end timestamp MM:SS, e.g. 0:08"),
  duration_seconds: z.number().describe("Sub-10-second duration (typically 4, 6, 8, or 10 seconds)"),
  lyric_line: z.string().default("").describe("Corresponding lyric line or musical cue during this shot"),
  setting_id: z.string().optional().describe("ID of the EnvironmentSetting used in this shot"),
  character_ids: z.array(z.string()).default([]).describe("IDs of characters appearing in this shot"),
  outfit_id: z.string().optional().describe("Specific character outfit ID active in this shot"),
  camera_and_action: z.string().describe("Camera angle, lens movement, and visual action description"),
  frame_mode: FrameModeSchema.describe(
    "'generate_start_frame' to generate a fresh starting keyframe image with Gemini, or 'use_previous_last_frame' to chain/continue from the last frame of the previous shot"
  ),
  end_frame_shot_id: z.string().optional().describe(
    "Optional shot_id whose starting image should be locked as the closing frame of this shot"
  ),
  keyframe_specification: z.string().describe(
    "Core visual description for this shot (before or including mandatory anchors)"
  ),
  compiled_image_prompt: z.string().optional().describe(
    "Full Gemini image generation prompt with Style Anchor, Character Anchor, and Setting prepended"
  ),
  compiled_video_prompt: z.string().optional().describe(
    "Full Google Flow Music video generation prompt including motion, camera, and continuity instructions"
  ),
  image_status: z
    .enum(["pending", "generated", "approved", "uses_previous_last_frame", "failed"])
    .default("pending"),
  image_path: z.string().optional().describe("Absolute path to the generated starting frame PNG in scenes/"),
  video_status: z
    .enum(["pending", "queued", "generating", "completed", "failed"])
    .default("pending"),
  video_path: z.string().optional().describe("Absolute path to the downloaded MP4 clip in videos/"),
  flow_asset_id: z.string().optional().describe("Asset/video identifier inside Google Flow Music"),
  notes: z.string().optional(),
});

export type SceneShot = z.infer<typeof SceneShotSchema>;

export const FlowMusicSessionInfoSchema = z.object({
  session_url: z.string().optional(),
  project_name: z.string().optional(),
  video_model: z.string().optional(),
  aspect_ratio: z.string().default("16:9"),
  resolution: z.string().default("720p"),
  mp3_uploaded: z.boolean().default(false),
  storyboard_initiated: z.boolean().default(false),
  last_synced_at: z.string().optional(),
});

export type FlowMusicSessionInfo = z.infer<typeof FlowMusicSessionInfoSchema>;

export const StoryboardProjectSchema = z.object({
  project_name: z.string(),
  folder_path: z.string(),
  mp3_file: z.string(),
  mp3_duration_seconds: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  song_metadata: z.object({
    title: z.string().default(""),
    artist: z.string().default(""),
    tempo_bpm: z.number().optional(),
    time_signature: z.string().optional(),
    mood: z.string().default(""),
    overall_theme: z.string().default(""),
    summary: z.string().default(""),
  }),
  style_anchor: z.string().describe(
    "Mandatory Style Anchor prepended to every image and video prompt, e.g. 'Pixar-style 3D stylized animation, soft warm lighting, tactile textures, rich color saturation, 8k resolution, cinematic composition'"
  ),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
  lyrics: z.array(LyricSegmentSchema).default([]),
  characters: z.array(CharacterSpecSchema).default([]),
  environments: z.array(EnvironmentSettingSchema).default([]),
  scenes: z.array(SceneShotSchema).default([]),
  flow_music_session: FlowMusicSessionInfoSchema.default({
    aspect_ratio: "16:9",
    resolution: "720p",
    mp3_uploaded: false,
    storyboard_initiated: false,
  }),
});

export type StoryboardProject = z.infer<typeof StoryboardProjectSchema>;
