#!/usr/bin/env node
import { FLOW_MUSIC_URL, getFlowMusicPage, PROFILE_DIR } from "./chrome.js";

async function main() {
  console.error(`Opening Google Flow Music (${FLOW_MUSIC_URL}) using dedicated Chrome profile at:`);
  console.error(`  ${PROFILE_DIR}`);
  console.error(`\nPlease sign in with your Google Account and make sure Google One / AI benefits are enabled.`);
  const page = await getFlowMusicPage();
  console.error(`Current URL: ${page.url()}`);
  console.error(`Leave the Chrome window open when you are ready to use flow-music-mcp in Claude.`);
}

main().catch((err) => {
  console.error("Login launch error:", err);
  process.exit(1);
});
