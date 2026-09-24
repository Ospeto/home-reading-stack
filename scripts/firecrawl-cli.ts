#!/usr/bin/env bun
/**
 * scripts/firecrawl-cli.ts
 *
 * LightHouse Firecrawl On-Demand Cluster CLI:
 *   - Inspects cluster state (running vs sleeping, memory release, idle timer).
 *   - Wakes containers on demand via `docker compose start` or `docker compose up -d`.
 *   - Stops containers via `docker compose stop` to release ~2.5 GB RAM back to macOS.
 *
 * CLI Usage:
 *   bin/lighthouse firecrawl <status|up|down>
 */

import process from "node:process";
import {
  getFirecrawlStatus,
  ensureFirecrawlRunning,
  stopFirecrawl,
} from "../uploader/firecrawl.ts";

const args = process.argv.slice(2);
const command = args[0] || "status";

async function main() {
  switch (command) {
    case "status": {
      const status = await getFirecrawlStatus();
      console.log("\n=======================================================");
      console.log("  LightHouse Firecrawl On-Demand Cluster Status");
      console.log("=======================================================");
      console.log(`  Enabled:        ${status.enabled ? "yes" : "no"}`);
      console.log(`  State:          ${status.running ? "\x1b[32mRUNNING\x1b[0m" : "\x1b[2mSTOPPED (Sleeping)\x1b[0m"}`);
      console.log(`  Endpoint URL:   ${status.url}`);
      console.log(`  Compose Dir:    ${status.composeDir}`);
      console.log(`  Auto-Sleep:     ${Math.round(status.idleTimeoutMs / 60000)} minutes`);
      console.log(`  Idle Timer:     ${status.idleTimerActive ? "Active" : "Inactive"}`);
      if (!status.running) {
        console.log("\n  [Tip] Firecrawl sleeps when idle to conserve ~2.5 GB RAM.");
        console.log("  It wakes up automatically on scrape requests or via 'bin/lighthouse firecrawl up'.");
      }
      console.log("=======================================================\n");
      break;
    }

    case "up": {
      console.log("[Firecrawl] Waking containers on-demand via docker compose...");
      const startTime = Date.now();
      const ready = await ensureFirecrawlRunning({ timeoutMs: 20000 });
      if (ready) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\x1b[32m[Firecrawl] Online and ready in ${elapsed}s!\x1b[0m`);
      } else {
        console.error("\x1b[31m[Firecrawl] Failed to wake containers or timed out.\x1b[0m");
        process.exit(1);
      }
      break;
    }

    case "down": {
      console.log("[Firecrawl] Stopping containers to release ~2.5 GB RAM...");
      const stopped = await stopFirecrawl({ force: true });
      if (stopped) {
        console.log("\x1b[32m[Firecrawl] Containers stopped. ~2.5 GB RAM released to macOS.\x1b[0m");
      } else {
        console.error("\x1b[31m[Firecrawl] Failed to stop containers cleanly.\x1b[0m");
        process.exit(1);
      }
      break;
    }

    case "help":
    case "--help":
    case "-h": {
      console.log(`
LightHouse Firecrawl On-Demand Cluster CLI

Usage:
  bin/lighthouse firecrawl <command>

Commands:
  status    Inspect cluster state, endpoint URL, and auto-sleep timer (default)
  up        Wake and start containers via docker compose
  down      Stop containers immediately to release ~2.5 GB RAM back to macOS
  help      Show this help message
`);
      break;
    }

    default:
      console.error(`Unknown firecrawl command: ${command}`);
      console.log("Run 'bin/lighthouse firecrawl help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[Firecrawl CLI Error] ${err.message}`);
  process.exit(1);
});
