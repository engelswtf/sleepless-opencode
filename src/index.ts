import "dotenv/config";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { initDb, TaskQueue } from "./db.js";
import { Daemon } from "./daemon.js";
import { Notifier } from "./notifier.js";
import { DiscordBot } from "./discord.js";
import { SlackBot } from "./slack.js";
import { HealthServer } from "./health.js";
import { getLogger } from "./logger.js";

const log = getLogger("main");

const VERSION = "1.0.0";

const LOCK_FILE = join(process.cwd(), "data", ".daemon.lock");

function acquireLock(): boolean {
  try {
    if (existsSync(LOCK_FILE)) {
      const pidStr = readFileSync(LOCK_FILE, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      
      // Check if process is still running
      try {
        process.kill(pid, 0); // Signal 0 just checks if process exists
        log.error("Another daemon is already running", { pid, lockFile: LOCK_FILE });
        return false;
      } catch {
        // Process not running, stale lock file
        log.warn("Removing stale lock file", { pid });
      }
    }
    
    writeFileSync(LOCK_FILE, process.pid.toString());
    return true;
  } catch (err) {
    log.error("Failed to acquire lock", { error: String(err) });
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
    log.info("Discord bot configured");
  }

  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    slackBot = new SlackBot(queue, {
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      notifyChannel: process.env.SLACK_NOTIFICATION_CHANNEL,
    });
    notifier.addChannel(slackBot);
    log.info("Slack bot configured");
  }

  if (process.env.WEBHOOK_URL) {
    const webhookEvents = process.env.WEBHOOK_EVENTS?.split(",").filter(Boolean) as ("started" | "completed" | "failed")[] | undefined;
    notifier.addWebhook({
      url: process.env.WEBHOOK_URL,
      secret: process.env.WEBHOOK_SECRET,
      events: webhookEvents,
    });
    log.info("Webhook configured");
  }

  if (!discordBot && !slackBot && !process.env.WEBHOOK_URL) {
    log.error("No notification channel configured. Set DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN/SLACK_APP_TOKEN, or WEBHOOK_URL");
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

  const healthPort = parseInt(process.env.HEALTH_PORT || "9090", 10);
  const healthServer = new HealthServer(queue, daemon, VERSION);
  await healthServer.start(healthPort);

  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
      log.warn("Already shutting down, please wait");
      return;
    }
    isShuttingDown = true;

    log.info("Received signal, starting graceful shutdown", { signal });
    
    const shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "60000", 10);
    await daemon.gracefulStop(shutdownTimeout);
    
    healthServer.stop();
    if (discordBot) await discordBot.stop();
    if (slackBot) await slackBot.stop();
    db.close();
    releaseLock();
    log.info("Shutdown complete");
    process.exit(0);
  };

  const forceShutdown = () => {
    log.warn("Force shutdown requested");
    daemon.stop();
    healthServer.stop();
    if (discordBot) discordBot.stop();
    if (slackBot) slackBot.stop();
    db.close();
    releaseLock();
    process.exit(1);
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGQUIT", forceShutdown);

  if (discordBot) await discordBot.start();
  if (slackBot) await slackBot.start();

  await daemon.start();
}

main().catch((err) => {
  log.error("Fatal error", { error: String(err) });
  process.exit(1);
});
