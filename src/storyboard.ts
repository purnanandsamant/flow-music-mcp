import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  type CharacterSpec,
  type EnvironmentSetting,
  type FrameMode,
  type LyricSegment,
  type SceneShot,
  type StoryboardProject,
  StoryboardProjectSchema,
} from "./types.js";

let activeFolderPath: string | null = null;

export function getActiveFolderPath(): string | null {
  return activeFolderPath;
}

export function setActiveFolderPath(folderPath: string): void {
  activeFolderPath = resolve(folderPath);
}

export function parseTimestampToSeconds(ts: string): number {
  const cleaned = ts.trim();
  const parts = cleaned.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return parts[0] ?? 0;
}

export function formatSecondsToTimestamp(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatShotId(shotNumber: number): string {
  return `shot-${String(shotNumber).padStart(2, "0")}`;
}

export function probeMp3DurationSeconds(mp3Path: string): number | undefined {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        mp3Path,
      ],
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    ).trim();
    const val = Number.parseFloat(out);
    if (Number.isFinite(val) && val > 0) {
      return Math.round(val * 10) / 10;
    }
  } catch {
    // Fallback if ffprobe is not installed: estimate from file size at 192 kbps
    try {
      const stats = statSync(mp3Path);
      if (stats.size > 0) {
        return Math.round(stats.size / (24 * 1024));
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function ensureProjectDirs(folderPath: string): {
  charactersDir: string;
  scenesDir: string;
  videosDir: string;
  jsonPath: string;
  mdPath: string;
} {
  const root = resolve(folderPath);
  const charactersDir = join(root, "characters");
  const scenesDir = join(root, "scenes");
  const videosDir = join(root, "videos");
  mkdirSync(charactersDir, { recursive: true });
  mkdirSync(scenesDir, { recursive: true });
  mkdirSync(videosDir, { recursive: true });
  return {
    charactersDir,
    scenesDir,
    videosDir,
    jsonPath: join(root, "storyboard.json"),
    mdPath: join(root, "STORYBOARD.md"),
  };
}

export function findMp3Files(folderPath: string): string[] {
  const root = resolve(folderPath);
  if (!existsSync(root)) {
    throw new Error(`Folder does not exist: ${root}`);
  }
  const entries = readdirSync(root);
  return entries
    .filter((f) => [".mp3", ".wav", ".m4a", ".flac", ".ogg"].includes(extname(f).toLowerCase()))
    .map((f) => join(root, f));
}

/**
 * Compile full image & video prompts for a shot using the project's Style Anchor,
 * Character Anchors, Outfit specification, and Environment/Lighting setting.
 */
export function compileScenePrompts(
  project: StoryboardProject,
  scene: SceneShot
): { compiledImagePrompt: string; compiledVideoPrompt: string } {
  const styleAnchor = project.style_anchor.trim();

  // Resolve Character Anchor(s)
  const charDescriptions: string[] = [];
  for (const charId of scene.character_ids) {
    const char = project.characters.find(
      (c) => c.id.toLowerCase() === charId.toLowerCase() || c.name.toLowerCase() === charId.toLowerCase()
    );
    if (char) {
      let desc = char.anchor_prompt || `${char.name}: ${char.proportions}, ${char.hair_and_eyes}`;
      const outfit = scene.outfit_id
        ? char.outfits.find((o) => o.id === scene.outfit_id || o.name === scene.outfit_id)
        : char.outfits[0];
      if (outfit) {
        desc += ` wearing ${outfit.description}`;
      }
      charDescriptions.push(desc);
    }
  }
  const characterAnchorText = charDescriptions.join(" | ");

  // Resolve Environment/Lighting Setting
  const env = scene.setting_id
    ? project.environments.find(
        (e) => e.id.toLowerCase() === scene.setting_id?.toLowerCase() || e.name.toLowerCase() === scene.setting_id?.toLowerCase()
      )
    : undefined;
  const envText = env ? `Environment & Lighting (${env.name}): ${env.description}.` : "";

  // Replace [Character Anchor] placeholder if present in keyframe_specification
  let keyframeSpec = scene.keyframe_specification.trim();
  if (keyframeSpec.includes("[Character Anchor]")) {
    keyframeSpec = keyframeSpec.replace(
      /\[Character Anchor\]/gi,
      characterAnchorText || "Lead character"
    );
  } else if (characterAnchorText && !keyframeSpec.toLowerCase().includes(characterAnchorText.slice(0, 20).toLowerCase())) {
    keyframeSpec = `${characterAnchorText}. ${keyframeSpec}`;
  }

  const imagePromptParts = [
    styleAnchor ? `Style Anchor: ${styleAnchor}.` : "",
    envText,
    `Camera & Composition: ${scene.camera_and_action}.`,
    `Scene Keyframe: ${keyframeSpec}`,
  ].filter(Boolean);

  const compiledImagePrompt = imagePromptParts.join(" ");

  const continuityInstruction =
    scene.frame_mode === "use_previous_last_frame"
      ? `CONTINUITY INSTRUCTION: Start seamlessly from the exact last frame of Shot ${scene.shot_number - 1} (${formatShotId(scene.shot_number - 1)}) with unbroken motion.`
      : `STARTING FRAME: Animate from the provided starting keyframe image (${scene.shot_id}.png).`;

  const videoPromptParts = [
    `[${scene.start_time}-${scene.end_time} | ${scene.duration_seconds}s | ${scene.section}]`,
    continuityInstruction,
    styleAnchor ? `Style: ${styleAnchor}.` : "",
    envText,
    `Camera & Motion: ${scene.camera_and_action}.`,
    `Visual Action: ${keyframeSpec}`,
    scene.lyric_line ? `Synced Lyric Cue: "${scene.lyric_line}"` : "",
  ].filter(Boolean);

  const compiledVideoPrompt = videoPromptParts.join(" ");

  return { compiledImagePrompt, compiledVideoPrompt };
}

export function refreshAllScenePrompts(project: StoryboardProject): StoryboardProject {
  project.scenes = project.scenes
    .sort((a, b) => a.shot_number - b.shot_number)
    .map((scene, idx) => {
      const shotNumber = idx + 1;
      const shotId = formatShotId(shotNumber);
      const startSec = parseTimestampToSeconds(scene.start_time);
      const endSec = parseTimestampToSeconds(scene.end_time);
      const duration =
        endSec > startSec ? Math.min(10, Math.max(2, endSec - startSec)) : scene.duration_seconds || 8;

      const updated: SceneShot = {
        ...scene,
        shot_number: shotNumber,
        shot_id: shotId,
        duration_seconds: duration,
        image_status:
          scene.frame_mode === "use_previous_last_frame" && scene.image_status === "pending"
            ? "uses_previous_last_frame"
            : scene.image_status === "uses_previous_last_frame" && scene.frame_mode === "generate_start_frame"
              ? "pending"
              : scene.image_status,
      };
      const { compiledImagePrompt, compiledVideoPrompt } = compileScenePrompts(project, updated);
      updated.compiled_image_prompt = compiledImagePrompt;
      updated.compiled_video_prompt = compiledVideoPrompt;
      return updated;
    });
  return project;
}

export function renderStoryboardMarkdown(project: StoryboardProject): string {
  const lines: string[] = [];
  lines.push(`# ${project.project_name} — Storyboard Production Bible`);
  lines.push(``);
  lines.push(`> **MP3 File**: \`${basename(project.mp3_file)}\` | **Folder**: \`${project.folder_path}\` | **Aspect Ratio**: \`${project.aspect_ratio}\``);
  lines.push(`> *You can edit this file directly or ask Claude to update scenes, characters, or prompts.*`);
  lines.push(``);

  // Song Metadata
  lines.push(`## 1. Song Metadata & Overview`);
  lines.push(`- **Title**: ${project.song_metadata.title || project.project_name}`);
  lines.push(`- **Artist**: ${project.song_metadata.artist || "N/A"}`);
  lines.push(`- **Duration**: ${project.mp3_duration_seconds ? `${formatSecondsToTimestamp(project.mp3_duration_seconds)} (${project.mp3_duration_seconds}s)` : "Unknown"}`);
  lines.push(`- **Tempo / Mood**: ${project.song_metadata.tempo_bpm ? `${project.song_metadata.tempo_bpm} BPM — ` : ""}${project.song_metadata.mood || "Not analyzed yet"}`);
  lines.push(`- **Overall Theme**: ${project.song_metadata.overall_theme || "Not specified yet"}`);
  if (project.song_metadata.summary) {
    lines.push(`- **Narrative Summary**: ${project.song_metadata.summary}`);
  }
  lines.push(``);

  // Style & Character Anchors
  lines.push(`## 2. Visual Production Bible & Asset Lock`);
  lines.push(`### Mandatory Style Anchor`);
  lines.push(`\`\`\`text`);
  lines.push(project.style_anchor);
  lines.push(`\`\`\``);
  lines.push(``);

  lines.push(`### Character Model Sheets`);
  if (project.characters.length === 0) {
    lines.push(`_No characters defined yet._`);
  } else {
    for (const char of project.characters) {
      lines.push(`#### Character: ${char.name} (\`${char.id}\`)`);
      lines.push(`- **Character Anchor**: \`${char.anchor_prompt}\``);
      lines.push(`- **Proportions**: ${char.proportions}`);
      lines.push(`- **Hair & Eyes**: ${char.hair_and_eyes}`);
      if (char.signature_props.length > 0) {
        lines.push(`- **Signature Props**: ${char.signature_props.join("; ")}`);
      }
      if (char.primary_image_path) {
        lines.push(`- **Primary Reference Sheet**: \`${char.primary_image_path}\``);
      }
      if (char.outfits.length > 0) {
        lines.push(`- **Outfits**:`);
        for (const o of char.outfits) {
          const palette = o.hex_palette.length ? ` [Palette: ${o.hex_palette.join(", ")}]` : "";
          const img = o.image_path ? ` → Image: \`${basename(o.image_path)}\`` : "";
          lines.push(`  - **${o.name}** (\`${o.id}\`${o.time_range ? `, ${o.time_range}` : ""}): ${o.description}${palette}${img}`);
        }
      }
      lines.push(``);
    }
  }

  lines.push(`### Environment & Lighting Direction`);
  if (project.environments.length === 0) {
    lines.push(`_No environment settings defined yet._`);
  } else {
    for (const env of project.environments) {
      lines.push(
        `- **${env.name}** (\`${env.id}\`${env.time_range ? `, ${env.time_range}` : ""}): ${env.description}${
          env.dominant_palette.length ? ` | Dominant Palette: ${env.dominant_palette.join(", ")}` : ""
        }${env.key_accents.length ? ` | Accents: ${env.key_accents.join(", ")}` : ""}${
          env.camera_style ? ` | Camera: ${env.camera_style}` : ""
        }`
      );
    }
  }
  lines.push(``);

  // Lyrics & Timestamps
  lines.push(`## 3. Identified Lyrics & Timestamps`);
  if (project.lyrics.length === 0) {
    lines.push(`_Lyrics not extracted yet. Run \`music_identify_lyrics\` to analyze the MP3._`);
  } else {
    lines.push(`| Timestamp | Section | Lyrics / Musical Cue | Mood / Notes |`);
    lines.push(`| :--- | :--- | :--- | :--- |`);
    for (const seg of project.lyrics) {
      lines.push(
        `| ${seg.start_time}–${seg.end_time} | ${seg.section} | ${seg.text.replace(/\|/g, "\\|")} | ${(seg.mood_notes ?? "").replace(/\|/g, "\\|")} |`
      );
    }
  }
  lines.push(``);

  // Storyboard Table
  lines.push(`## 4. Sub-10-Second Timestamp Storyboard & Google Flow Music Prompt Matrix`);
  lines.push(
    `> **Frame Mode Values**: \`generate_start_frame\` (Gemini generates starting keyframe image) or \`use_previous_last_frame\` (Google Flow Music uses last frame from previous scene).`
  );
  lines.push(``);
  if (project.scenes.length === 0) {
    lines.push(`_No scenes created yet._`);
  } else {
    lines.push(
      `| Shot | Timestamp | Section | Frame Mode | Characters / Setting | Camera & Visual Action | Keyframe & Flow Prompt Specification | Lyric Cue | Image Status | Video Status |`
    );
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const s of project.scenes) {
      const charSetting = [
        s.character_ids.length ? `Chars: ${s.character_ids.join(",")}` : "",
        s.outfit_id ? `Outfit: ${s.outfit_id}` : "",
        s.setting_id ? `Set: ${s.setting_id}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      const imgCell = s.image_path ? `${s.image_status} (\`scenes/${basename(s.image_path)}\`)` : s.image_status;
      const vidCell = s.video_path ? `${s.video_status} (\`videos/${basename(s.video_path)}\`)` : s.video_status;
      lines.push(
        `| ${s.shot_number} | ${s.start_time}–${s.end_time} | ${s.section.replace(/\|/g, "\\|")} | \`${s.frame_mode}\` | ${charSetting.replace(/\|/g, "\\|")} | ${s.camera_and_action.replace(/\|/g, "\\|")} | ${s.keyframe_specification.replace(/\|/g, "\\|")} | ${s.lyric_line.replace(/\|/g, "\\|")} | ${imgCell} | ${vidCell} |`
      );
    }
  }
  lines.push(``);
  return lines.join("\n");
}

/**
 * Syncs any direct user edits made inside STORYBOARD.md (specifically in Section 4 table or Style Anchor)
 * back into the StoryboardProject object.
 */
export function syncMarkdownEditsIntoProject(project: StoryboardProject, mdContent: string): StoryboardProject {
  // 1. Check if Mandatory Style Anchor block was modified
  const styleMatch = mdContent.match(/### Mandatory Style Anchor\s+```(?:text)?\r?\n([\s\S]*?)\r?\n```/);
  if (styleMatch && styleMatch[1]?.trim()) {
    project.style_anchor = styleMatch[1].trim();
  }

  // 2. Parse Section 4 Storyboard table rows if present
  const section4Index = mdContent.indexOf("## 4. Sub-10-Second Timestamp Storyboard");
  if (section4Index !== -1) {
    const tableBlock = mdContent.slice(section4Index);
    const rowLines = tableBlock
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|") && l.endsWith("|"));

    // Skip header and separator rows
    const dataRows = rowLines.filter(
      (l) => !l.includes("| Shot |") && !l.includes("| :---") && !l.includes("|---")
    );

    if (dataRows.length > 0) {
      const updatedScenes: SceneShot[] = [];
      for (const row of dataRows) {
        // Split by unescaped pipe
        const cells = row
          .slice(1, -1)
          .split(/(?<!\\)\|/)
          .map((c) => c.trim().replace(/\\\|/g, "|"));

        if (cells.length >= 7) {
          const shotNum = Number.parseInt(cells[0], 10);
          if (!Number.isFinite(shotNum)) continue;

          const existing = project.scenes.find((s) => s.shot_number === shotNum);
          const tsParts = cells[1].split(/[–-]/).map((p) => p.trim());
          const startTime = tsParts[0] || existing?.start_time || "0:00";
          const endTime = tsParts[1] || existing?.end_time || "0:08";
          const section = cells[2] || existing?.section || `Shot ${shotNum}`;
          const rawMode = cells[3].replace(/`/g, "").trim();
          const frameMode: FrameMode =
            rawMode === "use_previous_last_frame" ? "use_previous_last_frame" : "generate_start_frame";

          const cameraAndAction = cells[5] || existing?.camera_and_action || "";
          const keyframeSpec = cells[6] || existing?.keyframe_specification || "";
          const lyricLine = cells[7] !== undefined ? cells[7] : existing?.lyric_line ?? "";

          const startSec = parseTimestampToSeconds(startTime);
          const endSec = parseTimestampToSeconds(endTime);
          const duration = endSec > startSec ? Math.min(10, Math.max(2, endSec - startSec)) : existing?.duration_seconds ?? 8;

          updatedScenes.push({
            shot_number: shotNum,
            shot_id: formatShotId(shotNum),
            section,
            start_time: startTime,
            end_time: endTime,
            duration_seconds: duration,
            lyric_line: lyricLine,
            setting_id: existing?.setting_id,
            character_ids: existing?.character_ids ?? [],
            outfit_id: existing?.outfit_id,
            camera_and_action: cameraAndAction,
            frame_mode: frameMode,
            end_frame_shot_id: existing?.end_frame_shot_id,
            keyframe_specification: keyframeSpec,
            image_status: existing?.image_status ?? (frameMode === "use_previous_last_frame" ? "uses_previous_last_frame" : "pending"),
            image_path: existing?.image_path,
            video_status: existing?.video_status ?? "pending",
            video_path: existing?.video_path,
            flow_asset_id: existing?.flow_asset_id,
            notes: existing?.notes,
          });
        }
      }
      if (updatedScenes.length > 0) {
        project.scenes = updatedScenes;
      }
    }
  }

  return refreshAllScenePrompts(project);
}

export function saveProject(project: StoryboardProject): StoryboardProject {
  const { jsonPath, mdPath } = ensureProjectDirs(project.folder_path);
  project.updated_at = new Date().toISOString();
  refreshAllScenePrompts(project);
  writeFileSync(jsonPath, JSON.stringify(project, null, 2), "utf8");
  writeFileSync(mdPath, renderStoryboardMarkdown(project), "utf8");
  return project;
}

export function loadProject(folderPath?: string): StoryboardProject {
  const targetFolder = resolve(folderPath ?? activeFolderPath ?? "");
  if (!targetFolder || !existsSync(targetFolder)) {
    throw new Error(
      `No valid project folder connected. Call 'project_connect' with the folder path containing your MP3 first.`
    );
  }
  setActiveFolderPath(targetFolder);
  const { jsonPath, mdPath } = ensureProjectDirs(targetFolder);
  if (!existsSync(jsonPath)) {
    throw new Error(
      `No storyboard.json found in ${targetFolder}. Call 'project_connect' with folder_path="${targetFolder}" first.`
    );
  }

  let project = StoryboardProjectSchema.parse(JSON.parse(readFileSync(jsonPath, "utf8")));

  // If STORYBOARD.md was modified more recently than storyboard.json, sync user's Markdown edits automatically
  if (existsSync(mdPath)) {
    try {
      const jsonStat = statSync(jsonPath);
      const mdStat = statSync(mdPath);
      if (mdStat.mtimeMs > jsonStat.mtimeMs + 500) {
        const mdText = readFileSync(mdPath, "utf8");
        project = syncMarkdownEditsIntoProject(project, mdText);
        saveProject(project);
      }
    } catch {
      // Ignore stat errors
    }
  }

  return project;
}

export function connectProjectFolder(options: {
  folder_path: string;
  mp3_filename?: string;
  project_name?: string;
  style_anchor?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
}): { project: StoryboardProject; is_existing: boolean; available_audio_files: string[] } {
  const root = resolve(options.folder_path);
  if (!existsSync(root)) {
    throw new Error(`Folder does not exist: ${root}`);
  }
  setActiveFolderPath(root);
  const { jsonPath } = ensureProjectDirs(root);
  const audioFiles = findMp3Files(root);

  if (existsSync(jsonPath)) {
    const existing = loadProject(root);
    if (options.style_anchor) existing.style_anchor = options.style_anchor;
    if (options.aspect_ratio) existing.aspect_ratio = options.aspect_ratio;
    saveProject(existing);
    return {
      project: existing,
      is_existing: true,
      available_audio_files: audioFiles.map((f) => basename(f)),
    };
  }

  if (audioFiles.length === 0) {
    throw new Error(
      `No audio file (.mp3, .wav, .m4a, .flac, .ogg) found in ${root}. Please place your MP3 in the folder and try again.`
    );
  }

  const chosenMp3 = options.mp3_filename
    ? audioFiles.find((f) => basename(f).toLowerCase() === options.mp3_filename!.toLowerCase()) ?? audioFiles[0]
    : audioFiles[0];

  const durationSeconds = probeMp3DurationSeconds(chosenMp3);
  const defaultName =
    options.project_name ||
    basename(chosenMp3, extname(chosenMp3))
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const now = new Date().toISOString();
  const project: StoryboardProject = {
    project_name: defaultName,
    folder_path: root,
    mp3_file: chosenMp3,
    mp3_duration_seconds: durationSeconds,
    created_at: now,
    updated_at: now,
    song_metadata: {
      title: defaultName,
      artist: "",
      mood: "",
      overall_theme: "",
      summary: "",
    },
    style_anchor:
      options.style_anchor ||
      "Pixar-style 3D stylized animation, soft warm lighting, tactile textures, rich color saturation, 8k resolution, cinematic composition",
    aspect_ratio: options.aspect_ratio ?? "16:9",
    lyrics: [],
    characters: [],
    environments: [],
    scenes: [],
    flow_music_session: {
      aspect_ratio: options.aspect_ratio ?? "16:9",
      resolution: "720p",
      mp3_uploaded: false,
      storyboard_initiated: false,
    },
  };

  saveProject(project);
  return {
    project,
    is_existing: false,
    available_audio_files: audioFiles.map((f) => basename(f)),
  };
}
