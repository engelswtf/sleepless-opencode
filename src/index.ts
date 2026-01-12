import "dotenv/config";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { initDb, TaskQueue } from "./db.js";
import { Daemon } from "./daemon.js";
import { Notifier } from "./notifier.js";
import { DiscordBot } from "./discord.js";
import { SlackBot } from "./slack.js";

const LOCK_FILE = join(process.cwd(), "data", ".daemon.lock");

function acquireLock(): boolean {
  try {
    if (existsSync(LOCK_FILE)) {
      const pidStr = readFileSync(LOCK_FILE, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      
      // Check if process is still running
      try {
        process.kill(pid, 0); // Signal 0 just checks if process exists
        console.error(`[main] Another daemon is already running (PID: ${pid})`);
        console.error(`[main] If this is incorrect, delete ${LOCK_FILE}`);
        return false;
      } catch {
        // Process not running, stale lock file
        console.log(`[main] Removing stale lock file (PID ${pid} not running)`);
      }
    }
    
    writeFileSync(LOCK_FILE, process.pid.toString());
    return true;
  } catch (err) {
    console.error("[main] Failed to acquire lock:", err);
    return false;
  }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

async function main() {
  if (!acquireLock()) {
    process.exit(1);
  }
  const db = initDb();
  const queue = new TaskQueue(db);
  const notifier = new Notifier();

  let discordBot: DiscordBot | null = null;
  let slackBot: SlackBot | null = null;

  if (process.env.DISCORD_BOT_TOKEN) {
    discordBot = new DiscordBot(queue, {
      token: process.env.DISCORD_BOT_TOKEN,
      notifyUserId: process.env.DISCORD_NOTIFICATION_USER_ID,
      notifyChannelId: process.env.DISCORD_NOTIFICATION_CHANNEL_ID,
      allowedUserIds: process.env.DISCORD_ALLOWED_USER_IDS?.split(",").filter(Boolean),
      allowedChannelIds: process.env.DISCORD_ALLOWED_CHANNEL_IDS?.split(",").filter(Boolean),
    });
    notifier.addChannel(discordBot);
    console.log("[main] Discord bot configured");
  }

  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    slackBot = new SlackBot(queue, {
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      notifyChannel: process.env.SLACK_NOTIFICATION_CHANNEL,
    });
    notifier.addChannel(slackBot);
    console.log("[main] Slack bot configured");
  }

  if (!discordBot && !slackBot) {
    console.error("[main] ERROR: No bot configured. Set DISCORD_BOT_TOKEN or SLACK_BOT_TOKEN/SLACK_APP_TOKEN");
    process.exit(1);
  }

  const daemon = new Daemon(queue, notifier, {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
    workspacePath: process.env.OPENCODE_WORKSPACE || process.cwd(),
    opencodePath: process.env.OPENCODE_PATH,
    taskTimeoutMs: process.env.TASK_TIMEOUT_MS ? parseInt(process.env.TASK_TIMEOUT_MS, 10) : 30 * 60 * 1000,
    iterationTimeoutMs: process.env.ITERATION_TIMEOUT_MS ? parseInt(process.env.ITERATION_TIMEOUT_MS, 10) : 10 * 60 * 1000,
    model: process.env.OPENCODE_MODEL,
    agent: process.env.OPENCODE_AGENT,
  });

  const shutdown = async () => {
    console.log("\n[main] Shutting down...");
    daemon.stop();
    if (discordBot) await discordBot.stop();
    if (slackBot) await slackBot.stop();
    db.close();
    releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (discordBot) await discordBot.start();
  if (slackBot) await slackBot.start();

  await daemon.start();
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
