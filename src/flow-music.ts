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
import { saveProject } from "./storyboard.js";
import type { SceneShot, StoryboardProject } from "./types.js";

export interface FlowMusicStatus {
  connected: boolean;
  url: string;
  title: string;
  signed_in: boolean;
  login_hint?: string;
  credits_or_plan_text?: string;
  active_composer_found: boolean;
  visible_buttons: string[];
  visible_video_count: number;
}

async function findVisibleComposer(page: Page): Promise<Locator | null> {
  const selectors = [
    '.ProseMirror[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="video" i]',
    'textarea[placeholder*="describe" i]',
    'textarea[placeholder*="prompt" i]',
    'textarea[placeholder*="ask" i]',
    'textarea[placeholder*="music" i]',
    "textarea",
    '[contenteditable="true"]',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel).last();
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
    const visibleText = (el: Element): string => (el as HTMLElement).innerText?.trim() || el.getAttribute("aria-label") || "";
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

    const bodyText = document.body?.innerText || "";
    const creditMatch = bodyText.match(/(\d[\d,]*\s*credits?|\b(?:Pro|Ultra|Free|Google One)\b\s*plan)/i);
    const videos = Array.from(document.querySelectorAll("video")).filter(isVis).length;

    return {
      buttons: Array.from(new Set(buttons)).slice(0, 40),
      hasSignInButton,
      creditText: creditMatch ? creditMatch[0] : undefined,
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
    login_hint: signedIn
      ? undefined
      : "You are not signed in to Google Flow Music yet. Run 'flow_music_login' (or 'npm run login'), click 'Login -> Continue with Google' in the Chrome window, and check the box for Google One AI benefits.",
    credits_or_plan_text: evalData.creditText,
    active_composer_found: Boolean(composer),
    visible_buttons: evalData.buttons,
    visible_video_count: evalData.videos,
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
 * Follows the Google Flow Music Help workflow:
 * - Click "Add" (or "+" / "Add media") at the bottom-left of the prompt box -> select "Audio" or "Image"
 * - Or fallback to setting file input directly.
 */
export async function attachMediaToFlowMusic(
  page: Page,
  filePath: string,
  mediaType: "audio" | "image"
): Promise<{ uploaded: boolean; method: string }> {
  if (!existsSync(filePath)) {
    throw new Error(`File to upload does not exist: ${filePath}`);
  }

  // Strategy 1: Click "Add" / "+" button then click "Audio" or "Image" (or "Upload") with filechooser listener
  const addButtons = [
    /^add$/i,
    /add\s+media/i,
    /add\s+to\s+prompt/i,
    /add\s+ingredients/i,
    /attach/i,
    /^\+$/,
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
      // If clicking "Add" directly opened a filechooser or didn't match submenu, fall through
    }
  }

  // Strategy 2: Direct file input element in DOM
  const acceptSelector =
    mediaType === "audio"
      ? 'input[type="file"][accept*="audio" i], input[type="file"][accept*=".mp3" i]'
      : 'input[type="file"][accept*="image" i], input[type="file"][accept*=".png" i]';

  const specificInput = page.locator(acceptSelector).first();
  if ((await specificInput.count()) > 0) {
    await specificInput.setInputFiles(filePath);
    await page.waitForTimeout(2000);
    return { uploaded: true, method: `direct input[type=file] (${mediaType})` };
  }

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
 * Click Settings -> Video Generation -> Select your model
 */
export async function selectFlowMusicVideoModel(page: Page, modelName: string): Promise<boolean> {
  const clickedSettings = await clickByTextOrLabel(page, [/settings/i, /model/i], 3000);
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
 * Types a prompt into the active Google Flow Music composer and submits it
 * (clicks "Make the video", "Start generation", "Generate", "Send", or presses Enter).
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
  // Clear existing text safely
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});

  await composer.fill(promptText).catch(async () => {
    await page.keyboard.insertText(promptText);
  });
  await page.waitForTimeout(400);

  const submitPatterns =
    submitMode === "make_video"
      ? [
          /make\s+the\s+video/i,
          /make\s+video/i,
          /create\s+video/i,
          /start\s+generation/i,
          /^generate$/i,
          /^create$/i,
          /^send$/i,
          /submit/i,
        ]
      : [/^send$/i, /submit/i, /make\s+the\s+video/i, /start\s+generation/i, /^generate$/i];

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

  // Fallback: press Enter
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

  const mode = options.workflow_mode ?? "music_video";

  if (!/flowmusic\.app|flow\.google\.com/i.test(page.url())) {
    await page.goto(FLOW_MUSIC_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2000);
  }

  if (mode === "music_video") {
    // Follow Google Flow Music Help: On the left, select "Music videos" -> "New music video"
    await clickByTextOrLabel(page, [/^music\s*videos$/i, /music\s*video/i], 4000);
    await page.waitForTimeout(1000);
    await clickByTextOrLabel(page, [/new\s*music\s*video/i, /create\s*music\s*video/i, /^new$/i], 4000);
    await page.waitForTimeout(1500);
  } else if (mode === "project") {
    // On the left, select Projects -> New project
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
    // Start a new producer session
    await clickByTextOrLabel(page, [/new\s*session/i, /^sessions$/i, /start\s*new/i], 4000);
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
      // Wait briefly for video stream/file to finalize
      await page.waitForTimeout(2000);

      // Method 1: Try clicking the Download button inside Google Flow Music
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

      // Method 2: Fetch the video bytes directly inside the authenticated page context if http(s) or blob:
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

  // Optional: Send the master storyboard overview to the session first
  if (options.initiate_session_overview_first && !project.flow_music_session.storyboard_initiated) {
    const overviewLines = [
      `We are creating a cohesive Music Video Storyboard for "${project.song_metadata.title || project.project_name}".`,
      `Mandatory Style Anchor: ${project.style_anchor}`,
      project.characters.length
        ? `Character Lock: ${project.characters.map((c) => `${c.name} (${c.anchor_prompt})`).join(" | ")}`
        : "",
      `Total Shots: ${project.scenes.length} sub-10-second timestamped scenes synced to the lyrics.`,
      `Please lock this visual style and character consistency across the upcoming scene generations.`,
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

    // Snapshot existing video sources before starting this scene
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
      // Find the previous scene's generated video and extract its exact final frame!
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
          // If extraction fails, rely on Flow Music's continuation instruction in the prompt
        }
      }
    }

    if (imageToAttach && existsSync(imageToAttach)) {
      await attachMediaToFlowMusic(page, imageToAttach, "image");
    }

    const videoPrompt =
      scene.compiled_video_prompt ||
      `[${scene.start_time}-${scene.end_time}] ${project.style_anchor}. ${scene.camera_and_action}. ${scene.keyframe_specification}`;

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
