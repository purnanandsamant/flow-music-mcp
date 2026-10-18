# flow-music-mcp

An MCP (Model Context Protocol) server for **Claude Desktop** and **Claude Code** that turns a local `.mp3` folder into a full AI Music Video production pipeline using **Google Gemini** (audio transcription, lyrics/timestamps, character model sheets, and consistent scene keyframe images) and **Google Flow Music (`https://www.flowmusic.app/`)** (session-based storyboard video generation over Chrome DevTools Protocol).

---

## End-to-End Workflow

1. **Connect Folder & Identify Lyrics + Timestamps (`project_connect` → `music_identify_lyrics`)**
   - Point Claude to any local folder containing an `.mp3` (or `.wav`/`.m4a`).
   - Gemini multimodal audio analyzes the track and extracts timestamped lyrics (`MM:SS–MM:SS`), song structure (*Intro, Verse, Chorus, Bridge, Outro*), tempo/BPM, and mood.
2. **Create Sub-10-Second Storyboard Scenes & Frame Continuity (`storyboard_set_scenes`)**
   - Breaks the song into sub-10-second shots following the **Storyboard Production Bible** format.
   - Each scene explicitly sets its **`frame_mode`**:
     - `generate_start_frame`: Gemini generates a dedicated starting keyframe image (`scenes/shot-NN.png`).
     - `use_previous_last_frame`: Extracts the exact final frame from the previous scene's video and instructs Google Flow Music to continue seamlessly from that frame.
3. **Interactive Scene Editing (`storyboard_edit_scene` + Two-Way `STORYBOARD.md` Sync)**
   - Edit scenes, timestamps, camera directions, or `frame_mode` either by chatting with Claude **or** by editing `STORYBOARD.md` / `storyboard.json` directly in your folder.
4. **Character Sheets & Scene Keyframes via Gemini (`gemini_generate_character_image` → `gemini_generate_scene_images`)**
   - Work with Claude to lock your Character Model Sheets (with hex color palettes and outfit variants) in `<folder>/characters/`.
   - Generate all starting scene images in `<folder>/scenes/shot-NN.png` using Gemini Image Generation — automatically passing your character reference sheets as visual inputs so character appearance stays locked across every shot.
5. **Google Flow Music Session & Video Generation (`flow_music_new_session` → `flow_music_generate_videos`)**
   - Drives **Google Flow Music (`https://www.flowmusic.app/`)** in a dedicated Chrome profile via CDP.
   - Opens **Music videos → New music video** (or a new Producer Session), uploads your `.mp3` (`Add → Audio`), initiates the storyboard, attaches each scene's starting image (or extracted previous last frame), generates all videos, and downloads them to `<folder>/videos/shot-NN.mp4`.

---

## Setup & Installation

### 1. Install & Build
```powershell
npm install
npm run build
```

### 2. Configure Your Gemini API Key
You can either set `GEMINI_API_KEY` in your environment / Claude config, save it to `~/.flow-music-mcp/gemini-key`, or tell Claude in chat:
> *"Set my Gemini API key to ..."* (uses `gemini_set_api_key`).

### 3. Sign in to Google Flow Music (Once)
```powershell
npm run login
```
This opens a dedicated Chrome window at `https://www.flowmusic.app/` (stored in `~/.flow-music-mcp/chrome-profile`, completely separate from your personal browser). Sign in with your Google Account, enable your Google One AI benefits checkbox, and leave the Chrome window open.

---

## Connect to Claude

### Claude Code
```bash
# Windows (PowerShell)
claude mcp add --scope user flow-music -- node "C:\path\to\flow-music-mcp\dist\index.js"

# macOS / Linux
claude mcp add --scope user flow-music -- node "/absolute/path/to/flow-music-mcp/dist/index.js"
```

### Claude Desktop
Add to `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`, macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "flow-music": {
      "command": "node",
      "args": [
        "/absolute/path/to/flow-music-mcp/dist/index.js"
      ],
      "env": {
        "GEMINI_API_KEY": "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

---

## MCP Capabilities Reference

### Tools
| Tool | Phase | Description |
| :--- | :--- | :--- |
| `project_connect` | 0 | Connect to a local folder containing an `.mp3` and initialize `storyboard.json` + `STORYBOARD.md` |
| `gemini_set_api_key` | 0 | Save your Google AI Studio `GEMINI_API_KEY` to `~/.flow-music-mcp/gemini-key` |
| `music_identify_lyrics` | 1 | Analyze the `.mp3` with Gemini Audio to extract timestamped lyrics, song sections, and draft sub-10s scenes |
| `storyboard_get` | 2–3 | Read current storyboard state and auto-sync any direct edits made in `STORYBOARD.md` |
| `storyboard_set_production_bible` | 2–3 | Set the Mandatory Style Anchor, aspect ratio, and Environment/Lighting settings |
| `storyboard_upsert_character` | 2–4 | Define or update a character model sheet specification (proportions, outfits, hex palette, props) |
| `storyboard_set_scenes` | 2–3 | Replace the full sub-10s scene list with `frame_mode` (`generate_start_frame` or `use_previous_last_frame`) |
| `storyboard_edit_scene` | 3 | Update, insert, or delete an individual scene shot |
| `calculate_scene_frames` | 2–3 | Calculate exact frame count given shot duration in seconds and FPS |
| `gemini_generate_character_image` | 4 | Generate character reference sheet / outfit images with Gemini into `<folder>/characters/` |
| `gemini_generate_scene_images` | 4 | Generate scene starting keyframe images with Gemini (using character reference sheets) into `<folder>/scenes/` |
| `flow_music_login` | 5 | Open the dedicated Google Flow Music Chrome window (`https://www.flowmusic.app/`) for sign-in |
| `flow_music_status` | 5 | Check Google Flow Music sign-in status, active session URL, credits/plan text, and background tasks |
| `flow_music_new_session` | 5 | Start a new session / `Music videos -> New music video` in Google Flow Music and upload the `.mp3` |
| `flow_music_generate_videos` | 5 | Run the storyboard in Google Flow Music (uploading start frames or chaining last frames) and download `.mp4`s to `<folder>/videos/` |
| `flow_music_wait` | 5 | Wait on background tasks that run longer than 45 seconds |
| `flow_music_inspect_and_act` | 5 | Inspect live DOM/ARIA elements, take screenshots, or click/fill/upload on `https://www.flowmusic.app/` |

### Resources & Prompts
- **Resource `config://studio/character-lock`**: Returns the active project's Style & Character Consistency Lock.
- **Resource `storyboard://current/markdown`**: Returns the live `STORYBOARD.md` Production Bible.
- **Prompt `music_video_production_workflow`**: Guided 5-step prompt workflow for Claude.
- **Prompt `review_shot_prompt`**: Verifies a shot prompt against Character & Style Consistency rules.
