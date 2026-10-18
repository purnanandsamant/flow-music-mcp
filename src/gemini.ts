import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import {
  formatSecondsToTimestamp,
  formatShotId,
  parseTimestampToSeconds,
  refreshAllScenePrompts,
} from "./storyboard.js";
import type { CharacterSpec, LyricSegment, SceneShot, StoryboardProject } from "./types.js";

export const HOME_DIR = process.env.FLOW_MUSIC_MCP_HOME ?? join(homedir(), ".flow-music-mcp");
const LEGACY_FLOW_HOME = join(homedir(), ".flow-mcp");
const KEY_FILE = join(HOME_DIR, "gemini-key");
const LEGACY_KEY_FILE = join(LEGACY_FLOW_HOME, "gemini-key");

const GEMINI_AUDIO_MODEL = process.env.FLOW_MUSIC_GEMINI_MODEL ?? "gemini-2.5-flash";
const GEMINI_IMAGE_MODELS = [
  process.env.FLOW_MUSIC_GEMINI_IMAGE_MODEL,
  "gemini-2.5-flash-image-preview",
  "gemini-2.0-flash-preview-image-generation",
  "imagen-3.0-generate-002",
].filter((m): m is string => Boolean(m));

export function getGeminiApiKey(): string | undefined {
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8") : undefined,
    existsSync(LEGACY_KEY_FILE) ? readFileSync(LEGACY_KEY_FILE, "utf8") : undefined,
  ];
  for (const raw of candidates) {
    const key = (raw ?? "").trim();
    if (key && key.length >= 20 && !/^(YOUR|PASTE|<|\$)/i.test(key)) {
      return key;
    }
  }
  return undefined;
}

export function saveGeminiApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < 20) {
    throw new Error("Invalid Gemini API key: key looks too short.");
  }
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(KEY_FILE, trimmed, { encoding: "utf8", mode: 0o600 });
  return KEY_FILE;
}

function getAudioMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp3":
      return "audio/mp3";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".flac":
      return "audio/flac";
    case ".ogg":
      return "audio/ogg";
    default:
      return "audio/mpeg";
  }
}

async function uploadFileToGeminiFileApi(filePath: string, mimeType: string, apiKey: string): Promise<string> {
  const fileBytes = readFileSync(filePath);
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(fileBytes.byteLength),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: filePath.split(/[\\/]/).pop() ?? "audio.mp3" } }),
    }
  );

  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Gemini File API upload init failed (${startRes.status}): ${errText}`);
  }

  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Gemini File API did not return an x-goog-upload-url header.");
  }

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(fileBytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: fileBytes,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`Gemini File API upload finalize failed (${uploadRes.status}): ${errText}`);
  }

  const uploadJson = (await uploadRes.json()) as { file?: { uri?: string; name?: string; state?: string } };
  const fileUri = uploadJson.file?.uri;
  const fileName = uploadJson.file?.name;
  if (!fileUri || !fileName) {
    throw new Error(`Gemini File API returned unexpected payload: ${JSON.stringify(uploadJson)}`);
  }

  // Wait until file state is ACTIVE
  for (let i = 0; i < 30; i++) {
    const checkRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`
    );
    if (checkRes.ok) {
      const checkData = (await checkRes.json()) as { state?: string };
      if (checkData.state === "ACTIVE") return fileUri;
      if (checkData.state === "FAILED") {
        throw new Error(`Gemini audio processing failed for ${fileName}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  return fileUri;
}

/**
 * Step 1 & 2: Analyze the MP3 using Gemini multimodal audio to extract exact lyrics,
 * MM:SS timestamps, song sections, mood/BPM, and optionally draft sub-10-second storyboard scenes.
 */
export async function identifyLyricsAndTimestampsWithGemini(
  project: StoryboardProject,
  options: {
    auto_draft_scenes?: boolean;
    preferred_shot_duration_seconds?: number;
    creative_direction?: string;
  } = {}
): Promise<{
  lyrics: LyricSegment[];
  drafted_scenes_count: number;
  song_metadata: StoryboardProject["song_metadata"];
}> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY. Set GEMINI_API_KEY in your environment, save it to ~/.flow-music-mcp/gemini-key, or call the 'gemini_set_api_key' tool."
    );
  }

  if (!existsSync(project.mp3_file)) {
    throw new Error(`Audio file not found at ${project.mp3_file}`);
  }

  const mimeType = getAudioMimeType(project.mp3_file);
  const stats = statSync(project.mp3_file);

  let audioPart: Record<string, unknown>;
  if (stats.size <= 14 * 1024 * 1024) {
    const b64 = readFileSync(project.mp3_file).toString("base64");
    audioPart = {
      inlineData: {
        mimeType,
        data: b64,
      },
    };
  } else {
    const fileUri = await uploadFileToGeminiFileApi(project.mp3_file, mimeType, apiKey);
    audioPart = {
      fileData: {
        mimeType,
        fileUri,
      },
    };
  }

  const shotDur = options.preferred_shot_duration_seconds ?? 8;
  const durationHint = project.mp3_duration_seconds
    ? `The total audio duration is approximately ${formatSecondsToTimestamp(project.mp3_duration_seconds)} (${project.mp3_duration_seconds} seconds).`
    : "";

  const systemPrompt = `You are a Music Video Director & Audio Transcription Specialist working on a Google Flow Music Storyboard Production Bible.
Listen carefully to the attached audio track and extract:
1. Full song metadata: title (if recognizable or inferred), estimated tempo_bpm, time_signature, mood, overall_theme, and a concise visual narrative summary.
2. Complete timestamped lyrics & instrumental sections from 0:00 to the end of the track. Every vocal line or distinct instrumental phrase must have accurate start_time and end_time in MM:SS format (e.g., "0:00", "0:08", "1:24"), plus the song section ("Intro", "Verse 1", "Chorus 1", "Bridge", "Outro", etc.) and mood_notes.
${
  options.auto_draft_scenes
    ? `3. Also draft a sub-10-second storyboard scene breakdown (each shot ${shotDur}s or less, e.g. 6-9 seconds) covering the timeline, plus suggested lead character(s) and environment settings.
For each scene shot, decide its frame_mode:
- Use "generate_start_frame" when establishing a new scene, cutting to a new camera angle/subject, or changing environments.
- Use "use_previous_last_frame" when the shot should seamlessly continue the exact motion and framing from the end of the previous shot.
${options.creative_direction ? `User's creative direction: ${options.creative_direction}` : ""}`
    : ""
}

${durationHint}

Respond strictly with valid JSON matching this structure:
{
  "song_metadata": {
    "title": "string",
    "artist": "string",
    "tempo_bpm": 120,
    "time_signature": "4/4",
    "mood": "string",
    "overall_theme": "string",
    "summary": "string"
  },
  "lyrics": [
    {
      "section": "Intro",
      "start_time": "0:00",
      "end_time": "0:08",
      "text": "[Instrumental or exact lyric words]",
      "mood_notes": "string"
    }
  ],
  "suggested_characters": [
    {
      "id": "lead_char_id",
      "name": "Character Name",
      "proportions": "Build and proportions",
      "hair_and_eyes": "Hair and eye details",
      "signature_props": ["prop 1"],
      "anchor_prompt": "Concise mandatory Character Anchor description",
      "outfits": [
        {
          "id": "outfit_1",
          "name": "Outfit 1",
          "time_range": "0:00-0:41",
          "description": "Clothing description with hex colors",
          "hex_palette": ["#FFD700", "#D2143A"]
        }
      ]
    }
  ],
  "suggested_environments": [
    {
      "id": "setting_a",
      "name": "Setting A — Name",
      "time_range": "0:00-0:41",
      "description": "Detailed environment and lighting Kelvin description",
      "dominant_palette": ["#4A607A"],
      "key_accents": ["#FFB347"],
      "camera_style": "Camera movement style"
    }
  ],
  "suggested_scenes": [
    {
      "shot_number": 1,
      "section": "Intro",
      "start_time": "0:00",
      "end_time": "0:08",
      "lyric_line": "Corresponding lyric or instrumental cue",
      "setting_id": "setting_a",
      "character_ids": ["lead_char_id"],
      "outfit_id": "outfit_1",
      "camera_and_action": "Eye-level close-up; camera motion and action",
      "frame_mode": "generate_start_frame",
      "keyframe_specification": "Detailed visual keyframe prompt using [Character Anchor] when referencing lead character"
    }
  ]
}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_AUDIO_MODEL
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [audioPart, { text: systemPrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini audio analysis failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawJson = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!rawJson) {
    throw new Error("Gemini returned an empty response for audio analysis.");
  }

  const parsed = JSON.parse(rawJson) as {
    song_metadata?: Partial<StoryboardProject["song_metadata"]>;
    lyrics?: Array<{
      section?: string;
      start_time?: string;
      end_time?: string;
      text?: string;
      mood_notes?: string;
    }>;
    suggested_characters?: CharacterSpec[];
    suggested_environments?: StoryboardProject["environments"];
    suggested_scenes?: Array<Partial<SceneShot>>;
  };

  if (parsed.song_metadata) {
    project.song_metadata = {
      title: parsed.song_metadata.title || project.song_metadata.title || project.project_name,
      artist: parsed.song_metadata.artist || project.song_metadata.artist || "",
      tempo_bpm: parsed.song_metadata.tempo_bpm ?? project.song_metadata.tempo_bpm,
      time_signature: parsed.song_metadata.time_signature ?? project.song_metadata.time_signature,
      mood: parsed.song_metadata.mood || project.song_metadata.mood || "",
      overall_theme: parsed.song_metadata.overall_theme || project.song_metadata.overall_theme || "",
      summary: parsed.song_metadata.summary || project.song_metadata.summary || "",
    };
  }

  const lyrics: LyricSegment[] = (parsed.lyrics ?? []).map((seg, i) => {
    const startTime = seg.start_time || "0:00";
    const endTime = seg.end_time || "0:08";
    return {
      id: `lyric-${String(i + 1).padStart(2, "0")}`,
      section: seg.section || `Section ${i + 1}`,
      start_time: startTime,
      end_time: endTime,
      start_seconds: parseTimestampToSeconds(startTime),
      end_seconds: parseTimestampToSeconds(endTime),
      text: seg.text || "",
      mood_notes: seg.mood_notes,
    };
  });
  project.lyrics = lyrics;

  if (options.auto_draft_scenes) {
    if (parsed.suggested_characters?.length && project.characters.length === 0) {
      project.characters = parsed.suggested_characters.map((c) => ({
        ...c,
        signature_props: c.signature_props ?? [],
        outfits: (c.outfits ?? []).map((o) => ({
          ...o,
          hex_palette: o.hex_palette ?? [],
        })),
      }));
    }
    if (parsed.suggested_environments?.length && project.environments.length === 0) {
      project.environments = parsed.suggested_environments.map((e) => ({
        ...e,
        dominant_palette: e.dominant_palette ?? [],
        key_accents: e.key_accents ?? [],
      }));
    }
    if (parsed.suggested_scenes?.length) {
      project.scenes = parsed.suggested_scenes.map((s, idx) => {
        const shotNum = idx + 1;
        const startTime = s.start_time || "0:00";
        const endTime = s.end_time || "0:08";
        const startSec = parseTimestampToSeconds(startTime);
        const endSec = parseTimestampToSeconds(endTime);
        const dur = endSec > startSec ? Math.min(10, Math.max(2, endSec - startSec)) : 8;
        const frameMode =
          s.frame_mode === "use_previous_last_frame" && shotNum > 1
            ? "use_previous_last_frame"
            : "generate_start_frame";
        return {
          shot_number: shotNum,
          shot_id: formatShotId(shotNum),
          section: s.section || `Shot ${shotNum}`,
          start_time: startTime,
          end_time: endTime,
          duration_seconds: dur,
          lyric_line: s.lyric_line || "",
          setting_id: s.setting_id,
          character_ids: s.character_ids ?? [],
          outfit_id: s.outfit_id,
          camera_and_action: s.camera_and_action || "Medium shot, smooth cinematic motion",
          frame_mode: frameMode,
          keyframe_specification: s.keyframe_specification || "",
          image_status: frameMode === "use_previous_last_frame" ? "uses_previous_last_frame" : "pending",
          video_status: "pending",
        };
      });
      refreshAllScenePrompts(project);
    }
  }

  return {
    lyrics,
    drafted_scenes_count: project.scenes.length,
    song_metadata: project.song_metadata,
  };
}

/**
 * Low-level helper to generate an image via Gemini API (supporting multimodal reference images)
 * with automatic fallback across Gemini native image generation models and Imagen 3.
 */
export async function callGeminiImageGeneration(options: {
  prompt: string;
  aspectRatio?: string;
  referenceImagePaths?: string[];
  outputFilePath: string;
}): Promise<{ savedPath: string; modelUsed: string }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY. Set GEMINI_API_KEY in your environment, save it to ~/.flow-music-mcp/gemini-key, or call 'gemini_set_api_key'."
    );
  }

  const refParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  for (const refPath of options.referenceImagePaths ?? []) {
    if (refPath && existsSync(refPath)) {
      const ext = extname(refPath).toLowerCase();
      const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      refParts.push({
        inlineData: {
          mimeType,
          data: readFileSync(refPath).toString("base64"),
        },
      });
    }
  }

  const errors: string[] = [];

  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      if (model.startsWith("imagen-")) {
        // Imagen predict endpoint
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:predict?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              instances: [{ prompt: options.prompt }],
              parameters: {
                sampleCount: 1,
                aspectRatio: options.aspectRatio || "16:9",
              },
            }),
          }
        );

        if (!res.ok) {
          errors.push(`${model}: HTTP ${res.status} ${await res.text()}`);
          continue;
        }

        const data = (await res.json()) as {
          predictions?: Array<{ bytesBase64Encoded?: string }>;
        };
        const b64 = data.predictions?.[0]?.bytesBase64Encoded;
        if (b64) {
          writeFileSync(options.outputFilePath, Buffer.from(b64, "base64"));
          return { savedPath: options.outputFilePath, modelUsed: model };
        }
        errors.push(`${model}: No bytesBase64Encoded in response`);
      } else {
        // Gemini multimodal generateContent endpoint with responseModalities: ["TEXT", "IMAGE"]
        const promptWithRefs =
          refParts.length > 0
            ? `Maintain strict visual consistency with the attached character/style reference image(s). Aspect ratio: ${
                options.aspectRatio || "16:9"
              }.\n\nGenerate image: ${options.prompt}`
            : `Aspect ratio: ${options.aspectRatio || "16:9"}.\n\nGenerate image: ${options.prompt}`;

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [...refParts, { text: promptWithRefs }],
                },
              ],
              generationConfig: {
                responseModalities: ["TEXT", "IMAGE"],
              },
            }),
          }
        );

        if (!res.ok) {
          errors.push(`${model}: HTTP ${res.status} ${await res.text()}`);
          continue;
        }

        const data = (await res.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                inlineData?: { mimeType?: string; data?: string };
                text?: string;
              }>;
            };
          }>;
        };

        const parts = data.candidates?.[0]?.content?.parts ?? [];
        const imgPart = parts.find((p) => p.inlineData?.data);
        if (imgPart?.inlineData?.data) {
          writeFileSync(options.outputFilePath, Buffer.from(imgPart.inlineData.data, "base64"));
          return { savedPath: options.outputFilePath, modelUsed: model };
        }
        errors.push(`${model}: Response did not include inlineData image`);
      }
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All Gemini image generation models failed:\n- ${errors.join("\n- ")}`);
}

/**
 * Step 4a: Generate a Character Model Sheet image (or specific outfit sheet) using Gemini.
 */
export async function generateCharacterImageWithGemini(
  project: StoryboardProject,
  options: {
    character_id: string;
    outfit_id?: string;
    custom_prompt_override?: string;
    reference_image_path?: string;
  }
): Promise<{
  character_id: string;
  outfit_id?: string;
  saved_image_path: string;
  prompt_used: string;
  model_used: string;
}> {
  const char = project.characters.find(
    (c) =>
      c.id.toLowerCase() === options.character_id.toLowerCase() ||
      c.name.toLowerCase() === options.character_id.toLowerCase()
  );
  if (!char) {
    throw new Error(
      `Character '${options.character_id}' not found in storyboard. Available characters: ${
        project.characters.map((c) => c.id).join(", ") || "none"
      }`
    );
  }

  const outfit = options.outfit_id
    ? char.outfits.find(
        (o) =>
          o.id.toLowerCase() === options.outfit_id!.toLowerCase() ||
          o.name.toLowerCase() === options.outfit_id!.toLowerCase()
      )
    : char.outfits[0];

  const outfitDesc = outfit
    ? `Outfit (${outfit.name}): ${outfit.description}${
        outfit.hex_palette.length ? ` (Exact Hex Colors: ${outfit.hex_palette.join(", ")})` : ""
      }.`
    : "";

  const propsDesc = char.signature_props.length
    ? `Signature Props: ${char.signature_props.join("; ")}.`
    : "";

  const prompt =
    options.custom_prompt_override?.trim() ||
    [
      `Character Model Sheet / Reference Portrait.`,
      `Style Anchor: ${project.style_anchor}.`,
      `Character: ${char.name} — ${char.anchor_prompt}.`,
      `Proportions: ${char.proportions}.`,
      `Hair & Eyes: ${char.hair_and_eyes}.`,
      outfitDesc,
      propsDesc,
      `Clean neutral studio background, full-body front view and 3/4 expression view, ultra-detailed character turn-around reference sheet.`,
    ]
      .filter(Boolean)
      .join(" ");

  const fileSlug = outfit ? `${char.id}_${outfit.id}.png` : `${char.id}.png`;
  const outputPath = join(project.folder_path, "characters", fileSlug);

  // If generating a secondary outfit and primary_image_path already exists, pass it as a reference so the character's face/proportions stay locked!
  const refImages: string[] = [];
  if (options.reference_image_path && existsSync(options.reference_image_path)) {
    refImages.push(options.reference_image_path);
  } else if (char.primary_image_path && existsSync(char.primary_image_path)) {
    refImages.push(char.primary_image_path);
  }

  const { savedPath, modelUsed } = await callGeminiImageGeneration({
    prompt,
    aspectRatio: project.aspect_ratio,
    referenceImagePaths: refImages,
    outputFilePath: outputPath,
  });

  if (outfit) {
    outfit.image_path = savedPath;
  }
  if (!char.primary_image_path) {
    char.primary_image_path = savedPath;
  }

  return {
    character_id: char.id,
    outfit_id: outfit?.id,
    saved_image_path: savedPath,
    prompt_used: prompt,
    model_used: modelUsed,
  };
}

/**
 * Step 4b: Generate a scene starting keyframe image using Gemini, automatically attaching
 * the character model sheet reference images for strict character consistency.
 */
export async function generateSceneImageWithGemini(
  project: StoryboardProject,
  options: {
    shot_number: number;
    custom_prompt_override?: string;
    force_even_if_uses_last_frame?: boolean;
    include_previous_scene_image_as_reference?: boolean;
  }
): Promise<{
  shot_number: number;
  shot_id: string;
  frame_mode: string;
  saved_image_path?: string;
  skipped: boolean;
  prompt_used: string;
  reference_images_used: string[];
  model_used?: string;
}> {
  const scene = project.scenes.find((s) => s.shot_number === options.shot_number);
  if (!scene) {
    throw new Error(`Shot ${options.shot_number} does not exist in storyboard.`);
  }

  if (scene.frame_mode === "use_previous_last_frame" && !options.force_even_if_uses_last_frame) {
    scene.image_status = "uses_previous_last_frame";
    return {
      shot_number: scene.shot_number,
      shot_id: scene.shot_id,
      frame_mode: scene.frame_mode,
      skipped: true,
      prompt_used: scene.compiled_image_prompt || scene.keyframe_specification,
      reference_images_used: [],
    };
  }

  refreshAllScenePrompts(project);
  const prompt =
    options.custom_prompt_override?.trim() ||
    scene.compiled_image_prompt ||
    `${project.style_anchor}. ${scene.keyframe_specification}`;

  // Collect character reference images for all characters appearing in this shot
  const refImages: string[] = [];
  for (const charId of scene.character_ids) {
    const char = project.characters.find(
      (c) => c.id.toLowerCase() === charId.toLowerCase() || c.name.toLowerCase() === charId.toLowerCase()
    );
    if (char) {
      const outfit = scene.outfit_id
        ? char.outfits.find((o) => o.id === scene.outfit_id || o.name === scene.outfit_id)
        : undefined;
      const candidatePath = outfit?.image_path || char.primary_image_path || char.outfits.find((o) => o.image_path)?.image_path;
      if (candidatePath && existsSync(candidatePath) && !refImages.includes(candidatePath)) {
        refImages.push(candidatePath);
      }
    }
  }

  // Optionally attach previous scene's image for visual continuity
  if (options.include_previous_scene_image_as_reference && scene.shot_number > 1) {
    const prevScene = project.scenes.find((s) => s.shot_number === scene.shot_number - 1);
    if (prevScene?.image_path && existsSync(prevScene.image_path) && !refImages.includes(prevScene.image_path)) {
      refImages.push(prevScene.image_path);
    }
  }

  const outputPath = join(project.folder_path, "scenes", `${scene.shot_id}.png`);
  const { savedPath, modelUsed } = await callGeminiImageGeneration({
    prompt,
    aspectRatio: project.aspect_ratio,
    referenceImagePaths: refImages,
    outputFilePath: outputPath,
  });

  scene.image_path = savedPath;
  scene.image_status = "generated";
  if (options.custom_prompt_override) {
    scene.compiled_image_prompt = prompt;
  }

  return {
    shot_number: scene.shot_number,
    shot_id: scene.shot_id,
    frame_mode: scene.frame_mode,
    saved_image_path: savedPath,
    skipped: false,
    prompt_used: prompt,
    reference_images_used: refImages,
    model_used: modelUsed,
  };
}
