import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

export const FLOW_MUSIC_URL = process.env.FLOW_MUSIC_URL ?? "https://www.flowmusic.app/";
export const HOME_DIR = process.env.FLOW_MUSIC_MCP_HOME ?? join(homedir(), ".flow-music-mcp");
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
export const DOWNLOADS_DIR = join(HOME_DIR, "downloads");
export const CDP_PORT = Number(process.env.FLOW_MUSIC_CDP_PORT ?? 9334);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const CHROME_PATHS = [
  process.env.FLOW_MUSIC_CHROME,
  process.env.FLOW_MCP_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
].filter((p): p is string => Boolean(p));

let browserInstance: Browser | null = null;

export function findChromeExecutable(): string {
  const found = CHROME_PATHS.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "Google Chrome executable not found. Install Google Chrome or set FLOW_MUSIC_CHROME to its executable path."
    );
  }
  return found;
}

export async function isCdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function launchOrAttachChrome(initialUrl: string = FLOW_MUSIC_URL): Promise<Browser> {
  if (browserInstance?.isConnected()) {
    return browserInstance;
  }

  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(DOWNLOADS_DIR, { recursive: true });

  if (!(await isCdpUp())) {
    const chromeBin = findChromeExecutable();
    const child = spawn(
      chromeBin,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--lang=en-US",
        initialUrl,
      ],
      { detached: true, stdio: "ignore", windowsHide: false }
    );
    child.unref();

    for (let i = 0; i < 40; i++) {
      if (await isCdpUp()) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  browserInstance = await chromium.connectOverCDP(CDP_URL);
  browserInstance.on("disconnected", () => {
    browserInstance = null;
  });

  const ctx = browserInstance.contexts()[0];
  const page = ctx?.pages()[0];
  if (page) {
    try {
      const cdpSession = await ctx.newCDPSession(page);
      await cdpSession.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: DOWNLOADS_DIR,
        eventsEnabled: true,
      });
    } catch {
      // Ignore if Browser.setDownloadBehavior is unsupported in this context
    }
  }

  return browserInstance;
}

export async function getFlowMusicPage(): Promise<Page> {
  const b = await launchOrAttachChrome();
  const ctx = b.contexts()[0] ?? (await b.newContext());
  const pages = ctx.pages();

  let page = pages.find((p) => /flowmusic\.app|flow\.google\.com|labs\.google/i.test(p.url()));
  if (!page) {
    page = pages[0] ?? (await ctx.newPage());
    if (!page.url() || page.url() === "about:blank" || page.url().startsWith("chrome://")) {
      await page.goto(FLOW_MUSIC_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
  }

  try {
    const cdpSession = await ctx.newCDPSession(page);
    await cdpSession.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: DOWNLOADS_DIR,
      eventsEnabled: true,
    });
  } catch {
    // Ignore
  }

  await page.bringToFront().catch(() => {});
  return page;
}

/**
 * Waits for a newly downloaded file in DOWNLOADS_DIR (ignoring .crdownload/.tmp partial files)
 * and moves it to destinationPath.
 */
export async function waitForDownloadedFile(
  destinationPath: string,
  beforeFiles: Set<string>,
  timeoutMs: number = 90_000
): Promise<string> {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = readdirSync(DOWNLOADS_DIR).filter(
      (f) => !f.endsWith(".crdownload") && !f.endsWith(".tmp") && !f.startsWith(".")
    );
    const newFiles = current.filter((f) => !beforeFiles.has(f));

    if (newFiles.length > 0) {
      // Pick the newest file and verify its size has stabilized
      const candidate = join(DOWNLOADS_DIR, newFiles[0]);
      try {
        const s1 = statSync(candidate).size;
        if (s1 > 0) {
          await new Promise((r) => setTimeout(r, 1200));
          const s2 = statSync(candidate).size;
          if (s1 === s2) {
            if (existsSync(destinationPath)) {
              try {
                unlinkSync(destinationPath);
              } catch {
                // ignore
              }
            }
            renameSync(candidate, destinationPath);
            return destinationPath;
          }
        }
      } catch {
        // File still being written/renamed
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(`Timed out waiting for downloaded file to appear in ${DOWNLOADS_DIR}`);
}

/**
 * Extracts the exact final frame of an MP4 video clip to a PNG file so that subsequent
 * scenes marked `use_previous_last_frame` can use the exact final frame of the previous video!
 * Uses ffmpeg first if available, and falls back to HTML5 <video> + <canvas> inside Chrome via CDP.
 */
export async function extractLastFrameFromVideo(
  videoPath: string,
  outputPngPath: string,
  page?: Page
): Promise<string> {
  if (!existsSync(videoPath)) {
    throw new Error(`Cannot extract last frame: video file does not exist at ${videoPath}`);
  }

  // Method 1: Try ffmpeg (-sseof -0.1)
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-sseof", "-0.1", "-i", videoPath, "-frames:v", "1", "-q:v", "1", outputPngPath],
      { stdio: "ignore", timeout: 15_000, windowsHide: true }
    );
    if (existsSync(outputPngPath) && statSync(outputPngPath).size > 0) {
      return outputPngPath;
    }
  } catch {
    // Fall back to Chrome HTML5 <video> + <canvas> frame capture
  }

  // Method 2: Pure browser <video> + <canvas> capture via CDP (works even without ffmpeg!)
  const activePage = page ?? (await getFlowMusicPage());
  const videoBytesBase64 = readFileSync(videoPath).toString("base64");
  const pngBase64 = await activePage.evaluate(async (b64: string) => {
    return await new Promise<string>((resolve, reject) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.src = `data:video/mp4;base64,${b64}`;
      video.addEventListener("loadedmetadata", () => {
        const targetTime = Math.max(0, video.duration - 0.05);
        video.currentTime = targetTime;
      });
      video.addEventListener("seeked", () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 1280;
          canvas.height = video.videoHeight || 720;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("Canvas 2D context unavailable"));
            return;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/png");
          resolve(dataUrl.replace(/^data:image\/png;base64,/, ""));
        } catch (e) {
          reject(e);
        }
      });
      video.addEventListener("error", () => {
        reject(new Error("Failed to decode video in browser element"));
      });
    });
  }, videoBytesBase64);

  writeFileSync(outputPngPath, Buffer.from(pngBase64, "base64"));
  return outputPngPath;
}
