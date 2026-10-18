import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import {
  DOWNLOADS_DIR,
  extractLastFrameFromVideo,
  FLOW_MUSIC_URL,
  getFlowMusicPage,
  waitForDownloadedFile,
} from "./chrome.js";
import { getGeminiApiKey, KEY_FILE } from "./gemini.js";
import { saveProject } from "./storyboard.js";
import type { StoryboardProject } from "./types.js";

export const PLAYBOOK = {
  critical_rules: [
    "NEVER run bash/PowerShell searches to hunt for flow-music-mcp config files or API keys on the filesystem. Everything is managed directly through these MCP tools.",
    "Valid Google AI Studio keys start with EITHER 'AIza' OR 'AQ.' (2026 format). Accept 'AQ.' keys immediately via 'gemini_set_api_key' without questioning the user.",
    "You NEVER need to restart Claude to apply a new API key or image model. All keys and models are read dynamically on every call.",
    "If the user's Gemini API key is on the Free Tier (where image models have limit: 0), 'gemini_generate_character_image' and 'gemini_generate_scene_images' automatically fall back to generating the images inside the signed-in Google Flow Music Chrome window.",
  ],
  workflow_steps: [
    "1. Call 'project_connect' (or 'music_identify_lyrics' directly with folder_path) to connect to the user's MP3 song folder and extract timestamped lyrics & initial sub-10s scenes.",
    "2. Show the lyrics and sub-10s scenes (including each scene's frame_mode: 'generate_start_frame' vs 'use_previous_last_frame') to the user for review/editing ('storyboard_edit_scene').",
    "3. Define characters ('storyboard_upsert_character') and generate character sheets ('gemini_generate_character_image'), then generate scene starting keyframes ('gemini_generate_scene_images').",
    "4. Once scene images are approved, call 'flow_music_new_session' and 'flow_music_generate_videos' to initiate the storyboard in Google Flow Music (flowmusic.app) and download all MP4 scene clips.",
  ],
};

export interface FlowMusicStatus {
  connected: boolean;
  url: string;
  title: string;
  signed_in: boolean;
  account_or_plan?: string;
  gemini_api_key_configured: boolean;
  gemini_key_file: string;
  login_hint?: string;
  active_composer_found: boolean;
  visible_buttons: string[];
  visible_video_count: number;
  playbook: typeof PLAYBOOK;
}

async function findVisibleComposer(page: Page): Promise<Locator | null> {
  // Exact live selector on flowmusic.app first: textarea[aria-label="Chat message"]
  const selectors = [
    'textarea[aria-label="Chat message"]',
    'textarea[placeholder*="Let\'s create" i]',
    '.ProseMirror[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="video" i]',
    'textarea[placeholder*="describe" i]',
    'textarea[placeholder*="prompt" i]',
    "textarea",
    '[contenteditable="true"]',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      return loc;
    }
  }
  return null;
}

export async function getFlowMusicStatus(): Promise<FlowMusicStatus> {
  const page = await getFlowMusicPage();
  const url = page.url();
  const title = await page.title().catch(() => "");

  const evalData = await page.evaluate(() => {
    const visibleText = (el: Element): string =>
      (el as HTMLElement).innerText?.trim() || el.getAttribute("aria-label") || "";
    const isVis = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'))
      .filter(isVis)
      .map(visibleText)
      .filter((t) => t.length > 0 && t.length < 80);

    const hasSignInButton = buttons.some((b) =>
      /^(log\s*in|sign\s*in|continue with google)$/i.test(b.trim())
    );

    const settingsBtn = document.querySelector('button[aria-label="Settings menu"]') as HTMLElement | null;
    const accountText = settingsBtn?.innerText?.replace(/\s+/g, " ").trim();

    const bodyText = document.body?.innerText || "";
    const creditMatch = bodyText.match(
      /(\d[\d,]*\s*credits?|\b(?:PLUS|PRO|Ultra|Free|Google One)\b)/i
    );
    const videos = Array.from(document.querySelectorAll("video")).filter(isVis).length;

    return {
      buttons: Array.from(new Set(buttons)).slice(0, 40),
      hasSignInButton,
      accountOrPlan: accountText || (creditMatch ? creditMatch[0] : undefined),
      videos,
    };
  });

  const composer = await findVisibleComposer(page);
  const signedIn =
    !evalData.hasSignInButton &&
    !/accounts\.google\.com|\/login|\/about$/i.test(url) &&
    (Boolean(composer) || evalData.buttons.length > 2);

  return {
    connected: true,
    url,
    title,
    signed_in: signedIn,
    account_or_plan: evalData.accountOrPlan,
    gemini_api_key_configured: Boolean(getGeminiApiKey()),
    gemini_key_file: KEY_FILE,
    login_hint: signedIn
      ? undefined
      : "You are not signed in to Google Flow Music yet. Run 'flow_music_login' (or 'npm run login'), click 'Login -> Continue with Google' in the Chrome window, and check the box for Google One AI benefits.",
    active_composer_found: Boolean(composer),
    visible_buttons: evalData.buttons,
    visible_video_count: evalData.videos,
    playbook: PLAYBOOK,
  };
}

export async function inspectFlowMusicPage(): Promise<{
  url: string;
  title: string;
  buttons: Array<{ text: string; ariaLabel?: string }>;
  inputs: Array<{ tag: string; placeholder?: string; ariaLabel?: string; type?: string }>;
  nav_links: Array<{ text: string; href?: string }>;
  videos: Array<{ index: number; src?: string; duration?: number }>;
  page_text_excerpt: string;
}> {
  const page = await getFlowMusicPage();
  return await page.evaluate(() => {
    const isVis = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(isVis)
      .map((el) => ({
        text: ((el as HTMLElement).innerText || "").trim().slice(0, 80),
        ariaLabel: el.getAttribute("aria-label") || undefined,
      }))
      .filter((b) => b.text || b.ariaLabel);

    const inputs = Array.from(
      document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]')
    )
      .filter((el) => (el as HTMLInputElement).type === "file" || isVis(el))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        placeholder: el.getAttribute("placeholder") || undefined,
        ariaLabel: el.getAttribute("aria-label") || undefined,
        type: (el as HTMLInputElement).type || undefined,
      }));

    const nav_links = Array.from(document.querySelectorAll("nav a, aside a, [role='navigation'] a, a"))
      .filter(isVis)
      .map((el) => ({
        text: ((el as HTMLElement).innerText || "").trim().slice(0, 60),
        href: (el as HTMLAnchorElement).href || undefined,
      }))
      .filter((a) => a.text);

    const videos = Array.from(document.querySelectorAll("video")).map((v, i) => ({
      index: i,
      src: v.currentSrc || v.src || v.querySelector("source")?.src || undefined,
      duration: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : undefined,
    }));

    const page_text_excerpt = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500);

    return {
      url: window.location.href,
      title: document.title,
      buttons: buttons.slice(0, 60),
      inputs: inputs.slice(0, 30),
      nav_links: nav_links.slice(0, 40),
      videos,
      page_text_excerpt,
    };
  });
}

async function clickByTextOrLabel(page: Page, patterns: RegExp[], timeoutMs: number = 4000): Promise<boolean> {
  for (const pat of patterns) {
    try {
      const btn = page.getByRole("button", { name: pat }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: timeoutMs });
        return true;
      }
    } catch {
      // Try next strategy
    }
    try {
      const link = page.getByRole("link", { name: pat }).first();
      if ((await link.count()) > 0 && (await link.isVisible().catch(() => false))) {
        await link.click({ timeout: timeoutMs });
        return true;
      }
    } catch {
      // Try next strategy
    }
    try {
      const textLoc = page.getByText(pat).first();
      if ((await textLoc.count()) > 0 && (await textLoc.isVisible().catch(() => false))) {
        await textLoc.click({ timeout: timeoutMs });
        return true;
      }
    } catch {
      // Ignore
    }
  }
  return false;
}

/**
 * Uploads an audio (.mp3) or image (.png) reference into the Google Flow Music composer.
 * Uses the exact live selectors mapped from flowmusic.app:
 * - input[type="file"][aria-label="Upload audio file"]
 * - input[type="file"][aria-label="Upload image file"]
 * - button[aria-label="Add audio or image"]
 */
export async function attachMediaToFlowMusic(
  page: Page,
  filePath: string,
  mediaType: "audio" | "image"
): Promise<{ uploaded: boolean; method: string }> {
  if (!existsSync(filePath)) {
    throw new Error(`File to upload does not exist: ${filePath}`);
  }

  // Strategy 1 (Primary on flowmusic.app): Direct hidden file input by exact aria-label
  const exactAriaSelector =
    mediaType === "audio"
      ? 'input[type="file"][aria-label="Upload audio file"], input[type="file"][aria-label*="audio" i]'
      : 'input[type="file"][aria-label="Upload image file"], input[type="file"][aria-label*="image" i]';

  const exactInput = page.locator(exactAriaSelector).first();
  if ((await exactInput.count()) > 0) {
    await exactInput.setInputFiles(filePath);
    await page.waitForTimeout(2000);
    return { uploaded: true, method: `input[aria-label="Upload ${mediaType} file"]` };
  }

  // Strategy 2: Click button[aria-label="Add audio or image"] or "Add" -> "Audio" / "Image"
  const addButtons = [
    /add\s+audio\s+or\s+image/i,
    /^add$/i,
    /add\s+media/i,
    /add\s+to\s+prompt/i,
    /attach/i,
  ];

  const openedMenu = await clickByTextOrLabel(page, addButtons, 3000);
  if (openedMenu) {
    await page.waitForTimeout(500);
    const subMenuPatterns =
      mediaType === "audio"
        ? [/^audio$/i, /upload\s*audio/i, /music/i, /^upload$/i]
        : [/^image$/i, /upload\s*image/i, /photo/i, /start\s*frame/i, /^upload$/i];

    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 6000 }),
        clickByTextOrLabel(page, subMenuPatterns, 3000),
      ]);
      await chooser.setFiles(filePath);
      await page.waitForTimeout(2000);
      return { uploaded: true, method: `Add -> ${mediaType} menu filechooser` };
    } catch {
      // Fall through
    }
  }

  // Strategy 3: Generic file input fallback
  const anyFileInput = page.locator('input[type="file"]').first();
  if ((await anyFileInput.count()) > 0) {
    await anyFileInput.setInputFiles(filePath);
    await page.waitForTimeout(2000);
    return { uploaded: true, method: "generic input[type=file]" };
  }

  return { uploaded: false, method: "no_upload_control_found" };
}

/**
 * Selects the video generation model in Google Flow Music:
 * Click button[aria-label="Chat settings"] / Settings -> Video Generation -> Select your model
 */
export async function selectFlowMusicVideoModel(page: Page, modelName: string): Promise<boolean> {
  const clickedSettings = await clickByTextOrLabel(
    page,
    [/chat\s*settings/i, /^settings$/i, /model/i],
    3000
  );
  if (!clickedSettings) return false;
  await page.waitForTimeout(400);

  await clickByTextOrLabel(page, [/video\s*generation/i, /select\s*model/i], 2500);
  await page.waitForTimeout(400);

  const escaped = modelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const picked = await clickByTextOrLabel(page, [new RegExp(escaped, "i")], 3000);
  await page.keyboard.press("Escape").catch(() => {});
  return picked;
}

/**
 * Types a prompt into the active Google Flow Music composer (textarea[aria-label="Chat message"])
 * and submits it via button[aria-label="Send message"] or "Make the video".
 */
export async function submitPromptInFlowMusic(
  page: Page,
  promptText: string,
  submitMode: "make_video" | "chat" = "make_video"
): Promise<{ submitted: boolean; button_clicked?: string }> {
  const composer = await findVisibleComposer(page);
  if (!composer) {
    throw new Error(
      "Could not find the prompt box on the Google Flow Music page. Make sure you are signed in and inside a Session or 'Music videos -> New music video'. Call 'flow_music_inspect_and_act' to inspect the current screen."
    );
  }

  await composer.click({ timeout: 5000 });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});

  await composer.fill(promptText).catch(async () => {
    await page.keyboard.insertText(promptText);
  });
  await page.waitForTimeout(400);

  // Check exact aria-label="Send message" button first or "Make the video"
  const sendMsgBtn = page.locator('button[aria-label="Send message"]').first();
  if ((await sendMsgBtn.count()) > 0 && (await sendMsgBtn.isVisible().catch(() => false)) && (await sendMsgBtn.isEnabled().catch(() => true))) {
    await sendMsgBtn.click({ timeout: 4000 });
    return { submitted: true, button_clicked: 'button[aria-label="Send message"]' };
  }

  const submitPatterns =
    submitMode === "make_video"
      ? [
          /make\s+the\s+video/i,
          /make\s+video/i,
          /send\s+message/i,
          /create\s+video/i,
          /start\s+generation/i,
          /^generate$/i,
          /^send$/i,
        ]
      : [/send\s+message/i, /^send$/i, /submit/i, /make\s+the\s+video/i, /^generate$/i];

  for (const pat of submitPatterns) {
    try {
      const btn = page.getByRole("button", { name: pat }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => true))) {
        await btn.click({ timeout: 4000 });
        return { submitted: true, button_clicked: pat.source };
      }
    } catch {
      // Try next
    }
  }

  await page.keyboard.press("Enter");
  return { submitted: true, button_clicked: "Enter_key" };
}

/**
 * Starts a new session or "Music videos -> New music video" in Google Flow Music,
 * attaches the folder's MP3 audio track, and optionally configures the video model.
 */
export async function startNewFlowMusicSession(
  project: StoryboardProject,
  options: {
    workflow_mode?: "music_video" | "session" | "project";
    attach_mp3?: boolean;
    video_model?: string;
  } = {}
): Promise<{
  session_url: string;
  workflow_mode: string;
  mp3_attached: boolean;
  mp3_upload_method?: string;
  model_selected?: string;
}> {
  const page = await getFlowMusicPage();
  const status = await getFlowMusicStatus();
  if (!status.signed_in) {
    throw new Error(
      status.login_hint ||
        "Please sign in to Google Flow Music first by calling 'flow_music_login' or running 'npm run login'."
    );
  }

  const mode = options.workflow_mode ?? "session";

  if (!/flowmusic\.app/i.test(page.url())) {
    await page.goto(FLOW_MUSIC_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2000);
  }

  if (mode === "music_video") {
    // Try clicking "Make video" chip or navigating to /session / /library/videos
    const clickedMakeVideo = await clickByTextOrLabel(
      page,
      [/^make\s*video$/i, /new\s*music\s*video/i, /^new\s*session$/i],
      3500
    );
    if (!clickedMakeVideo) {
      await page.goto("https://www.flowmusic.app/session", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    await page.waitForTimeout(1500);
  } else if (mode === "project") {
    await clickByTextOrLabel(page, [/^projects$/i], 4000);
    await page.waitForTimeout(800);
    await clickByTextOrLabel(page, [/new\s*project/i], 4000);
    await page.waitForTimeout(1000);
    const nameInput = page.locator('input[type="text"], input[placeholder*="name" i]').first();
    if ((await nameInput.count()) > 0 && (await nameInput.isVisible().catch(() => false))) {
      await nameInput.fill(project.project_name);
      await clickByTextOrLabel(page, [/^create$/i, /^save$/i], 3000);
      await page.waitForTimeout(1500);
    }
  } else {
    const clickedNewSession = await clickByTextOrLabel(page, [/^new\s*session$/i], 3500);
    if (!clickedNewSession) {
      await page.goto("https://www.flowmusic.app/session", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    await page.waitForTimeout(1500);
  }

  if (options.video_model) {
    await selectFlowMusicVideoModel(page, options.video_model);
    project.flow_music_session.video_model = options.video_model;
  }

  let mp3Attached = false;
  let mp3Method: string | undefined;
  if (options.attach_mp3 !== false && existsSync(project.mp3_file)) {
    const up = await attachMediaToFlowMusic(page, project.mp3_file, "audio");
    mp3Attached = up.uploaded;
    mp3Method = up.method;
    project.flow_music_session.mp3_uploaded = mp3Attached;
  }

  project.flow_music_session.session_url = page.url();
  project.flow_music_session.project_name = project.project_name;
  project.flow_music_session.last_synced_at = new Date().toISOString();
  saveProject(project);

  return {
    session_url: page.url(),
    workflow_mode: mode,
    mp3_attached: mp3Attached,
    mp3_upload_method: mp3Method,
    model_selected: options.video_model,
  };
}

/**
 * Waits for a new video element or downloadable video card to finish rendering in Google Flow Music,
 * then downloads it to destinationMp4Path.
 */
async function waitForAndDownloadNewVideo(
  page: Page,
  beforeVideoSources: Set<string>,
  destinationMp4Path: string,
  timeoutMs: number = 240_000
): Promise<{ downloaded: boolean; video_path?: string; video_src?: string; note?: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);

    const state = await page.evaluate((knownSrcs: string[]) => {
      const known = new Set(knownSrcs);
      const bodyText = document.body?.innerText || "";
      const isGenerating =
        /\b(\d{1,2}%|generating\s+video|making\s+the\s+video|rendering|creating\s+video)\b/i.test(bodyText);

      const videos = Array.from(document.querySelectorAll("video"));
      const newVideos = videos
        .map((v) => v.currentSrc || v.src || v.querySelector("source")?.src || "")
        .filter((src) => src.length > 0 && !known.has(src));

      return {
        isGenerating,
        newVideoSrc: newVideos[0] || null,
        totalVideos: videos.length,
      };
    }, Array.from(beforeVideoSources));

    if (state.newVideoSrc) {
      await page.waitForTimeout(2000);

      mkdirSync(DOWNLOADS_DIR, { recursive: true });
      const beforeDownloads = new Set(readdirSync(DOWNLOADS_DIR));
      const clickedDownload = await clickByTextOrLabel(
        page,
        [/^download$/i, /download\s*video/i, /download\s*media/i, /1080p/i, /720p/i],
        3500
      );

      if (clickedDownload) {
        try {
          const saved = await waitForDownloadedFile(destinationMp4Path, beforeDownloads, 45_000);
          return { downloaded: true, video_path: saved, video_src: state.newVideoSrc };
        } catch {
          // Fall back to direct fetch of the video src inside the authenticated browser context
        }
      }

      try {
        const b64 = await page.evaluate(async (srcUrl: string) => {
          const resp = await fetch(srcUrl, { credentials: "include" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = await resp.arrayBuffer();
          let binary = "";
          const bytes = new Uint8Array(buf);
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
          }
          return btoa(binary);
        }, state.newVideoSrc);

        if (b64 && b64.length > 100) {
          writeFileSync(destinationMp4Path, Buffer.from(b64, "base64"));
          return { downloaded: true, video_path: destinationMp4Path, video_src: state.newVideoSrc };
        }
      } catch (err) {
        return {
          downloaded: false,
          video_src: state.newVideoSrc,
          note: `Video rendered in Flow Music (${state.newVideoSrc}), but automatic download needed manual click: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
  }

  return {
    downloaded: false,
    note: "Timed out waiting for new video element to finish rendering in Google Flow Music.",
  };
}

/**
 * Initiates the full storyboard context in the active Google Flow Music session and generates
 * videos for the specified scenes (or all scenes in sequence).
 */
export async function generateStoryboardVideosInFlowMusic(
  project: StoryboardProject,
  options: {
    shot_numbers?: number[];
    initiate_session_overview_first?: boolean;
    video_model?: string;
    per_video_timeout_seconds?: number;
  } = {}
): Promise<{
  session_url: string;
  results: Array<{
    shot_number: number;
    shot_id: string;
    frame_mode: string;
    reference_image_attached?: string;
    prompt_submitted: string;
    video_status: string;
    video_path?: string;
    note?: string;
  }>;
}> {
  const page = await getFlowMusicPage();
  const status = await getFlowMusicStatus();
  if (!status.signed_in) {
    throw new Error(
      status.login_hint || "Not signed in to Google Flow Music. Run 'flow_music_login' first."
    );
  }

  if (options.video_model) {
    await selectFlowMusicVideoModel(page, options.video_model);
    project.flow_music_session.video_model = options.video_model;
  }

  const targetScenes = options.shot_numbers?.length
    ? project.scenes.filter((s) => options.shot_numbers!.includes(s.shot_number))
    : project.scenes;

  if (targetScenes.length === 0) {
    throw new Error("No matching scenes found in the storyboard to generate.");
  }

  if (options.initiate_session_overview_first && !project.flow_music_session.storyboard_initiated) {
    const overviewLines = [
      `We are creating a cohesive Music Video Storyboard for "${project.song_metadata.title || project.project_name}".`,
      `Mandatory Style Anchor: ${project.style_anchor}`,
      project.characters.length
        ? `Character Lock: ${project.characters.map((c) => `${c.name} (${c.anchor_prompt})`).join(" | ")}`
        : "",
      `Total Shots: ${project.scenes.length} sub-10-second timestamped scenes synced to the lyrics.`,
      `Please lock this visual style and character consistency across the upcoming scene video generations.`,
    ].filter(Boolean);

    await submitPromptInFlowMusic(page, overviewLines.join("\n"), "chat");
    await page.waitForTimeout(3000);
    project.flow_music_session.storyboard_initiated = true;
    saveProject(project);
  }

  const results: Array<{
    shot_number: number;
    shot_id: string;
    frame_mode: string;
    reference_image_attached?: string;
    prompt_submitted: string;
    video_status: string;
    video_path?: string;
    note?: string;
  }> = [];

  const timeoutMs = (options.per_video_timeout_seconds ?? 240) * 1000;

  for (const scene of targetScenes) {
    scene.video_status = "generating";
    saveProject(project);

    const beforeSrcs = new Set<string>(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll("video"))
          .map((v) => v.currentSrc || v.src || v.querySelector("source")?.src || "")
          .filter(Boolean)
      )
    );

    let imageToAttach: string | undefined;

    if (scene.frame_mode === "generate_start_frame") {
      if (scene.image_path && existsSync(scene.image_path)) {
        imageToAttach = scene.image_path;
      } else {
        const defaultPath = join(project.folder_path, "scenes", `${scene.shot_id}.png`);
        if (existsSync(defaultPath)) {
          imageToAttach = defaultPath;
          scene.image_path = defaultPath;
        }
      }
    } else if (scene.frame_mode === "use_previous_last_frame") {
      const prevScene = project.scenes.find((s) => s.shot_number === scene.shot_number - 1);
      const prevVideoPath =
        prevScene?.video_path ||
        join(project.folder_path, "videos", `shot-${String(scene.shot_number - 1).padStart(2, "0")}.mp4`);

      if (existsSync(prevVideoPath)) {
        const extractedLastFramePng = join(
          project.folder_path,
          "scenes",
          `${scene.shot_id}_from_prev_last_frame.png`
        );
        try {
          await extractLastFrameFromVideo(prevVideoPath, extractedLastFramePng, page);
          imageToAttach = extractedLastFramePng;
          scene.image_path = extractedLastFramePng;
        } catch {
          // Fallback to prompt instruction
        }
      }
    }

    if (imageToAttach && existsSync(imageToAttach)) {
      await attachMediaToFlowMusic(page, imageToAttach, "image");
    }

    const videoPrompt =
      scene.compiled_video_prompt ||
      `Make video for Shot ${scene.shot_number} [${scene.start_time}-${scene.end_time}]: ${project.style_anchor}. ${scene.camera_and_action}. ${scene.keyframe_specification}`;

    await submitPromptInFlowMusic(page, videoPrompt, "make_video");

    const destinationMp4 = join(project.folder_path, "videos", `${scene.shot_id}.mp4`);
    const dlResult = await waitForAndDownloadNewVideo(page, beforeSrcs, destinationMp4, timeoutMs);

    if (dlResult.downloaded && dlResult.video_path) {
      scene.video_status = "completed";
      scene.video_path = dlResult.video_path;
    } else {
      scene.video_status = "failed";
    }
    if (dlResult.note) {
      scene.notes = dlResult.note;
    }

    saveProject(project);

    results.push({
      shot_number: scene.shot_number,
      shot_id: scene.shot_id,
      frame_mode: scene.frame_mode,
      reference_image_attached: imageToAttach ? basename(imageToAttach) : undefined,
      prompt_submitted: videoPrompt,
      video_status: scene.video_status,
      video_path: scene.video_path,
      note: dlResult.note,
    });
  }

  return {
    session_url: page.url(),
    results,
  };
}

/**
 * Interactive low-level escape hatch so Claude can inspect, click, type, upload, or screenshot
 * anything inside the Google Flow Music Chrome window.
 */
export async function interactWithFlowMusicPage(options: {
  action: "inspect" | "navigate" | "click" | "fill" | "upload_audio" | "upload_image" | "screenshot";
  target?: string;
  value?: string;
  save_path?: string;
}): Promise<unknown> {
  const page = await getFlowMusicPage();

  switch (options.action) {
    case "inspect":
      return await inspectFlowMusicPage();

    case "navigate": {
      const targetUrl = options.target || FLOW_MUSIC_URL;
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1500);
      return await inspectFlowMusicPage();
    }

    case "click": {
      if (!options.target) throw new Error("'target' button text or CSS selector is required for click.");
      const pat = new RegExp(options.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const clickedByText = await clickByTextOrLabel(page, [pat], 4000);
      if (!clickedByText) {
        await page.locator(options.target).first().click({ timeout: 5000 });
      }
      await page.waitForTimeout(1000);
      return { clicked: options.target, current_url: page.url() };
    }

    case "fill": {
      if (!options.value) throw new Error("'value' text is required for fill.");
      if (options.target) {
        const loc = page.locator(options.target).first();
        await loc.click({ timeout: 4000 });
        await loc.fill(options.value);
      } else {
        await submitPromptInFlowMusic(page, options.value, "make_video");
      }
      return { filled: true, current_url: page.url() };
    }

    case "upload_audio": {
      if (!options.target) throw new Error("'target' file path is required for upload_audio.");
      return await attachMediaToFlowMusic(page, options.target, "audio");
    }

    case "upload_image": {
      if (!options.target) throw new Error("'target' file path is required for upload_image.");
      return await attachMediaToFlowMusic(page, options.target, "image");
    }

    case "screenshot": {
      const outPath =
        options.save_path || join(DOWNLOADS_DIR, `flow-music-screen-${Date.now()}.png`);
      mkdirSync(DOWNLOADS_DIR, { recursive: true });
      await page.screenshot({ path: outPath, fullPage: false });
      return { screenshot_path: outPath, url: page.url() };
    }
  }
}
