import { setDefaultResultOrder } from "node:dns";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { getFlowMusicPage, launchOrAttachChrome } from "./chrome.js";
import {
  formatSecondsToTimestamp,
  formatShotId,
  parseTimestampToSeconds,
  refreshAllScenePrompts,
} from "./storyboard.js";
import type { CharacterSpec, LyricSegment, SceneShot, StoryboardProject } from "./types.js";

// Ensure IPv4 is tried first on Windows so Node's fetch() to generativelanguage.googleapis.com never hangs on IPv6 timeouts
try {
  setDefaultResultOrder("ipv4first");
} catch {
  // Ignore if unsupported
}

export const HOME_DIR = process.env.FLOW_MUSIC_MCP_HOME ?? join(homedir(), ".flow-music-mcp");
const LEGACY_FLOW_HOME = join(homedir(), ".flow-mcp");
export const KEY_FILE = join(HOME_DIR, "gemini-key");
const LEGACY_KEY_FILE = join(LEGACY_FLOW_HOME, "gemini-key");
export const CONFIG_FILE = join(HOME_DIR, "config.json");

export interface RuntimeConfig {
  gemini_audio_model?: string;
  gemini_image_model?: string;
  prefer_browser_image_generation?: boolean;
}

export function loadRuntimeConfig(): RuntimeConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as RuntimeConfig;
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

export function saveRuntimeConfig(update: Partial<RuntimeConfig>): RuntimeConfig {
  mkdirSync(HOME_DIR, { recursive: true });
  const current = loadRuntimeConfig();
  const next = { ...current, ...update };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

// Current 2026 Gemini Image models verified on Google AI Studio
export const DEFAULT_GEMINI_IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-nano-banana-2.1",
  "gemini-2.5-flash-image",
  "gemini-3-pro-image",
  "gemini-3.1-flash-lite-image",
  "nano-banana-pro-preview",
];

/**
 * Resolves the Gemini API key dynamically on every call (no restart needed).
 * Supports both traditional 'AIza...' keys and newer 2026 'AQ....' Google AI Studio keys.
 */
export function getGeminiApiKey(): string | undefined {
  const candidates = [
    existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8") : undefined,
    existsSync(LEGACY_KEY_FILE) ? readFileSync(LEGACY_KEY_FILE, "utf8") : undefined,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
  ];
  for (const raw of candidates) {
    const key = (raw ?? "").trim();
    if (key && key.length >= 20 && !/^(YOUR|PASTE|<|\$)/i.test(key)) {
      return key;
    }
  }
  return undefined;
}

export async function saveAndVerifyGeminiApiKey(apiKey: string): Promise<{
  key_file: string;
  key_prefix: string;
  verified: boolean;
  available_image_models: string[];
  available_audio_models: string[];
  note?: string;
}> {
  const trimmed = apiKey.trim();
  if (trimmed.length < 20) {
    throw new Error("Invalid Gemini API key: key looks too short.");
  }
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(KEY_FILE, trimmed, { encoding: "utf8", mode: 0o600 });

  let verified = false;
  let imageModels: string[] = [];
  let audioModels: string[] = [];
  let note: string | undefined;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(trimmed)}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (res.ok) {
      verified = true;
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (data.models ?? [])
        .map((m) => (m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
      imageModels = names.filter((n) => /image|imagen|banana/i.test(n));
      audioModels = names.filter((n) => /flash|pro/i.test(n) && !/image|tts/i.test(n)).slice(0, 8);
    } else {
      note = `Saved key, but models list check returned HTTP ${res.status}.`;
    }
  } catch (err) {
    note = `Saved key locally (network check skipped: ${err instanceof Error ? err.message : String(err)})`;
  }

  return {
    key_file: KEY_FILE,
    key_prefix: `${trimmed.slice(0, 6)}...`,
    verified,
    available_image_models: imageModels,
    available_audio_models: audioModels,
    note,
  };
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
      body: JSON.stringify({ file: { display_name: basename(filePath) } }),
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

  const uploadJson = (await uploadRes.json()) as { file?: { uri?: string; name?: string } };
  const fileUri = uploadJson.file?.uri;
  const fileName = uploadJson.file?.name;
  if (!fileUri || !fileName) {
    throw new Error(`Gemini File API returned unexpected payload: ${JSON.stringify(uploadJson)}`);
  }

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
    audio_model?: string;
  } = {}
): Promise<{
  lyrics: LyricSegment[];
  drafted_scenes_count: number;
  song_metadata: StoryboardProject["song_metadata"];
  model_used: string;
}> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      `Missing GEMINI_API_KEY. Ask the user for their Google AI Studio API key (starts with 'AIza' or 'AQ.') and pass it to the 'gemini_set_api_key' tool. Do NOT search the filesystem.`
    );
  }

  if (!existsSync(project.mp3_file)) {
    throw new Error(`Audio file not found at ${project.mp3_file}`);
  }

  const cfg = loadRuntimeConfig();
  const audioModel =
    options.audio_model ||
    cfg.gemini_audio_model ||
    process.env.FLOW_MUSIC_GEMINI_MODEL ||
    "gemini-2.5-flash";

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
      audioModel
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
    throw new Error(`Gemini audio analysis failed (${res.status} on ${audioModel}): ${errText}`);
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
    model_used: audioModel,
  };
}

let freeTierZeroQuotaDetected = false;

/**
 * Generates an image using the user's signed-in Google Gemini Web Chat (`https://gemini.google.com/app`)
 * inside the persistent MCP Chrome profile (port 9334).
 *
 * Why this is awesome:
 * 1. Completely free / included with the user's Google account (no AI Studio API billing needed!).
 * 2. Supports attaching Character Model Sheet reference PNGs via ClipboardEvent("paste") DataTransfer
 *    so scene start frames maintain strict character consistency without opening OS file dialogs.
 * 3. Extracts the generated `blob:https://gemini.google.com/...` image on the same origin (or via HTML5
 *    canvas) with zero CORS issues.
 */
export async function generateImageViaGeminiWebChat(options: {
  prompt: string;
  aspectRatio?: string;
  referenceImagePaths?: string[];
  outputFilePath: string;
}): Promise<{ savedPath: string; modelUsed: string }> {
  const b = await launchOrAttachChrome();
  const ctx = b.contexts()[0] ?? (await b.newContext());

  // Reuse an existing gemini.google.com tab or open a new tab
  let page = ctx.pages().find((p) => p.url().startsWith("https://gemini.google.com"));
  const openedNewTab = !page;
  if (!page) {
    page = await ctx.newPage();
  }

  try {
    // Navigate to a fresh Gemini chat so the DOM has no prior generated images
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(2500);

    const promptBox = page
      .locator(
        'div[role="textbox"][aria-label*="prompt" i], rich-textarea div[contenteditable="true"], div[contenteditable="true"]'
      )
      .first();

    await promptBox.waitFor({ state: "visible", timeout: 15_000 });
    await promptBox.click();

    // Snapshot any existing blob images (e.g., avatars) before we attach or generate
    const knownBlobUrls = new Set<string>(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll("img"))
          .map((img) => img.currentSrc || img.src || "")
          .filter(Boolean)
      )
    );

    // Attach reference images (e.g. Character Model Sheet PNGs) via synthetic ClipboardEvent("paste")
    for (const refPath of options.referenceImagePaths ?? []) {
      if (refPath && existsSync(refPath)) {
        const ext = extname(refPath).toLowerCase();
        const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        const fileName = basename(refPath);
        const b64Data = readFileSync(refPath).toString("base64");

        await page.evaluate(
          async ({ b64, name, mime }: { b64: string; name: string; mime: string }) => {
            const binStr = atob(b64);
            const bytes = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) {
              bytes[i] = binStr.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: mime });
            const file = new File([blob], name, { type: mime });
            const dt = new DataTransfer();
            dt.items.add(file);

            const editor =
              document.querySelector('div[role="textbox"][aria-label*="prompt" i]') ||
              document.querySelector('rich-textarea div[contenteditable="true"]') ||
              document.querySelector('div[contenteditable="true"]');
            if (!editor) throw new Error("Gemini Chat prompt textbox not found for image paste");

            const pasteEvent = new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: dt,
            });
            editor.dispatchEvent(pasteEvent);
          },
          { b64: b64Data, name: fileName, mime: mimeType }
        );

        // Give Gemini Web Chat a moment to process the pasted attachment thumbnail
        await page.waitForTimeout(2200);
      }
    }

    // Record any newly added attachment thumbnail URLs so we don't confuse them with the generated output image
    const afterAttachUrls = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .map((img) => img.currentSrc || img.src || "")
        .filter(Boolean)
    );
    for (const u of afterAttachUrls) {
      knownBlobUrls.add(u);
    }

    // Fill the image generation prompt
    const ratioText = options.aspectRatio || "16:9";
    const fullChatPrompt =
      (options.referenceImagePaths?.length ?? 0) > 0
        ? `Generate a single ${ratioText} widescreen image maintaining strict visual consistency with the attached character/style reference image. Output the generated image directly: ${options.prompt}`
        : `Generate a single ${ratioText} widescreen image. Output the generated image directly: ${options.prompt}`;

    await promptBox.click();
    await promptBox.fill(fullChatPrompt);
    await page.waitForTimeout(500);

    // Click Send message
    const sendBtn = page
      .locator('button[aria-label*="Send message" i], button[aria-label*="Send" i]')
      .first();
    if ((await sendBtn.count()) > 0 && (await sendBtn.isVisible().catch(() => false))) {
      await sendBtn.click({ timeout: 5000 });
    } else {
      await page.keyboard.press("Enter");
    }

    // Poll up to 75 seconds for the generated image (`alt` containing "AI generated" or new large blob image)
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2500);

      const extractedBase64 = await page.evaluate(async (ignoredUrls: string[]) => {
        const ignoreSet = new Set(ignoredUrls);
        const candidates = Array.from(document.querySelectorAll("img")).filter((img) => {
          const src = img.currentSrc || img.src || "";
          if (!src || ignoreSet.has(src)) return false;
          const alt = (img.alt || "").toLowerCase();
          if (alt === "attachment" || alt.includes("profile")) return false;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          return img.complete && w >= 250 && h >= 200;
        });

        if (candidates.length === 0) return null;
        const targetImg = candidates[candidates.length - 1];
        const srcUrl = targetImg.currentSrc || targetImg.src || "";

        // Method A: Same-origin fetch on blob:https://gemini.google.com/...
        try {
          const resp = await fetch(srcUrl);
          if (resp.ok) {
            const buf = await resp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            if (bytes.length > 2000) {
              let binary = "";
              const chunkSize = 0x8000;
              for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
              }
              return btoa(binary);
            }
          }
        } catch {
          // Fall through to Canvas extraction
        }

        // Method B: Draw HTMLImageElement directly to an HTML5 Canvas
        try {
          const canvas = document.createElement("canvas");
          canvas.width = targetImg.naturalWidth || targetImg.width || 1024;
          canvas.height = targetImg.naturalHeight || targetImg.height || 576;
          const ctx2d = canvas.getContext("2d");
          if (ctx2d) {
            ctx2d.drawImage(targetImg, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL("image/png");
            return dataUrl.replace(/^data:image\/png;base64,/, "");
          }
        } catch {
          // Ignore
        }
        return null;
      }, Array.from(knownBlobUrls));

      if (extractedBase64 && extractedBase64.length > 500) {
        writeFileSync(options.outputFilePath, Buffer.from(extractedBase64, "base64"));
        return {
          savedPath: options.outputFilePath,
          modelUsed: "gemini-web-chat (gemini.google.com/app)",
        };
      }
    }

    throw new Error(
      "Timed out waiting for Gemini Web Chat (https://gemini.google.com/app) to finish rendering the image."
    );
  } finally {
    if (openedNewTab) {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Generates an image via Gemini API (supporting multimodal reference images)
 * using the live 2026 model names + automatic fallback to Gemini Web Chat (`https://gemini.google.com/app`)
 * when the user's API key is on the unbilled Free Tier (`limit: 0`).
 */
export async function callGeminiImageGeneration(options: {
  prompt: string;
  aspectRatio?: string;
  referenceImagePaths?: string[];
  outputFilePath: string;
  preferredModel?: string;
}): Promise<{ savedPath: string; modelUsed: string }> {
  const cfg = loadRuntimeConfig();
  const apiKey = getGeminiApiKey();

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

  const modelsToTry = Array.from(
    new Set(
      [
        options.preferredModel,
        cfg.gemini_image_model,
        process.env.FLOW_MUSIC_GEMINI_IMAGE_MODEL,
        ...DEFAULT_GEMINI_IMAGE_MODELS,
      ].filter((m): m is string => Boolean(m))
    )
  );

  const errors: string[] = [];

  if (apiKey && !cfg.prefer_browser_image_generation && !freeTierZeroQuotaDetected) {
    for (const model of modelsToTry) {
      try {
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
          const errText = await res.text();
          errors.push(`${model}: HTTP ${res.status} ${errText.slice(0, 220)}`);
          if (res.status === 429 && /free_tier_requests|limit:\s*0|RESOURCE_EXHAUSTED/i.test(errText)) {
            freeTierZeroQuotaDetected = true;
            // Cache that this API key is on the Free Tier (limit: 0 for image models) and switch immediately to Gemini Web Chat!
            break;
          }
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
      } catch (err) {
        errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Fallback (or primary when Free-Tier API key has limit: 0): Use signed-in Gemini Web Chat (https://gemini.google.com/app)
  try {
    return await generateImageViaGeminiWebChat({
      prompt: options.prompt,
      aspectRatio: options.aspectRatio,
      referenceImagePaths: options.referenceImagePaths,
      outputFilePath: options.outputFilePath,
    });
  } catch (browserErr) {
    throw new Error(
      `Image generation failed.\nAPI Attempts:\n- ${
        errors.length ? errors.join("\n- ") : "Skipped (Free-Tier API key limit: 0 cached)"
      }\nGemini Web Chat Fallback (https://gemini.google.com/app): ${
        browserErr instanceof Error ? browserErr.message : String(browserErr)
      }\nEnsure the MCP Chrome window is open and signed into your Google account (run flow_music_login if closed).`
    );
  }
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
    image_model?: string;
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
    preferredModel: options.image_model,
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
    image_model?: string;
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

  const refImages: string[] = [];
  for (const charId of scene.character_ids) {
    const char = project.characters.find(
      (c) => c.id.toLowerCase() === charId.toLowerCase() || c.name.toLowerCase() === charId.toLowerCase()
    );
    if (char) {
      const outfit = scene.outfit_id
        ? char.outfits.find((o) => o.id === scene.outfit_id || o.name === scene.outfit_id)
        : undefined;
      const candidatePath =
        outfit?.image_path ||
        char.primary_image_path ||
        char.outfits.find((o) => o.image_path)?.image_path;
      if (candidatePath && existsSync(candidatePath) && !refImages.includes(candidatePath)) {
        refImages.push(candidatePath);
      }
    }
  }

  if (options.include_previous_scene_image_as_reference && scene.shot_number > 1) {
    const prevScene = project.scenes.find((s) => s.shot_number === scene.shot_number - 1);
    if (
      prevScene?.image_path &&
      existsSync(prevScene.image_path) &&
      !refImages.includes(prevScene.image_path)
    ) {
      refImages.push(prevScene.image_path);
    }
  }

  const outputPath = join(project.folder_path, "scenes", `${scene.shot_id}.png`);
  const { savedPath, modelUsed } = await callGeminiImageGeneration({
    prompt,
    aspectRatio: project.aspect_ratio,
    referenceImagePaths: refImages,
    outputFilePath: outputPath,
    preferredModel: options.image_model,
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
