#!/usr/bin/env node
import { createInterface } from "readline";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

function print(msg: string) {
  console.log(msg);
}

async function main() {
  print("\nsleepless-opencode Setup\n");
  print("This wizard will help you configure sleepless-opencode.\n");
  print("-".repeat(50));

  const config: Record<string, string> = {};

  print("\nBot Configuration\n");
  print("You need at least ONE bot (Discord OR Slack).\n");

  const useDiscord = (await question("Set up Discord bot? (Y/n): ")).toLowerCase() !== "n";
  const useSlack = (await question("Set up Slack bot? (Y/n): ")).toLowerCase() !== "n";

  if (!useDiscord && !useSlack) {
    print("\nError: You must configure at least one bot (Discord or Slack).");
    process.exit(1);
  }

  if (useDiscord) {
    print("\nDiscord Setup\n");
    print("1. Go to https://discord.com/developers/applications");
    print("2. Create a new application");
    print("3. Go to 'Bot' tab, create bot, copy token");
    print("4. Go to 'OAuth2' then 'URL Generator'");
    print("   - Scopes: bot, applications.commands");
    print("   - Permissions: Send Messages, Use Slash Commands");
    print("5. Use the generated URL to invite bot to your server\n");

    config.DISCORD_BOT_TOKEN = await question("Discord Bot Token: ");

    if (!config.DISCORD_BOT_TOKEN) {
      print("Error: Discord token is required if using Discord.");
      process.exit(1);
    }

    print("\nNotification preferences:");
    const notifyMethod = await question("Notify via (1) DM, (2) Channel, (3) Both? [1]: ");

    if (notifyMethod === "2" || notifyMethod === "3") {
      config.DISCORD_NOTIFICATION_CHANNEL_ID = await question("Channel ID for notifications: ");
    }

    if (notifyMethod !== "2") {
      config.DISCORD_NOTIFICATION_USER_ID = await question("Your Discord User ID (for DMs): ");
    }
  }

  if (useSlack) {
    print("\nSlack Setup\n");
    print("1. Go to https://api.slack.com/apps");
    print("2. Create a new app, select 'From scratch'");
    print("3. Enable Socket Mode, generate App Token (xapp-...)");
    print("4. OAuth & Permissions, add Bot Token Scopes:");
    print("   - chat:write, commands");
    print("5. Slash Commands, create:");
    print("   - /task, /status, /tasks, /cancel");
    print("6. Install to Workspace, copy Bot Token (xoxb-...)\n");

    config.SLACK_BOT_TOKEN = await question("Slack Bot Token (xoxb-...): ");
    config.SLACK_APP_TOKEN = await question("Slack App Token (xapp-...): ");

    if (!config.SLACK_BOT_TOKEN || !config.SLACK_APP_TOKEN) {
      print("Error: Both Slack tokens are required if using Slack.");
      process.exit(1);
    }

    config.SLACK_NOTIFICATION_CHANNEL = await question("Slack channel for notifications (optional): ");
  }

  print("\nDaemon Configuration\n");

  const workspace = await question(`Default workspace path [${process.cwd()}]: `);
  if (workspace) config.OPENCODE_WORKSPACE = workspace;

  const pollInterval = await question("Poll interval in ms [5000]: ");
  if (pollInterval) config.POLL_INTERVAL_MS = pollInterval;

  const taskTimeout = await question("Task timeout in minutes [30]: ");
  if (taskTimeout) config.TASK_TIMEOUT_MS = String(parseInt(taskTimeout, 10) * 60 * 1000);

  const dataDir = await question(`Data directory [${join(process.cwd(), "data")}]: `);
  if (dataDir) config.SLEEPLESS_DATA_DIR = dataDir;

  print("\nWriting configuration...\n");

  const envContent = Object.entries(config)
    .filter(([_, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  writeFileSync(".env", envContent + "\n");
  print("Created .env file");

  if (config.SLEEPLESS_DATA_DIR && !existsSync(config.SLEEPLESS_DATA_DIR)) {
    mkdirSync(config.SLEEPLESS_DATA_DIR, { recursive: true });
    print(`Created data directory: ${config.SLEEPLESS_DATA_DIR}`);
  }

  print("\nSetup Complete!\n");
  print("-".repeat(50));
  print("\nNext steps:\n");
  print("1. Start the daemon:");
  print("   npm run dev     (development)");
  print("   npm start       (production)\n");

  print("2. Or install as a service:");
  print("   sudo cp sleepless-opencode.service /etc/systemd/system/");
  print("   sudo systemctl enable sleepless-opencode");
  print("   sudo systemctl start sleepless-opencode\n");

  if (useDiscord) {
    print("3. Discord commands will be available in ~1 minute:");
    print("   /task <prompt>  - Submit a task");
    print("   /status         - Check queue");
    print("   /tasks          - List tasks");
    print("   /cancel <id>    - Cancel task\n");
  }

  if (useSlack) {
    print("3. Slack commands:");
    print("   /task <prompt>  - Submit a task");
    print("   /status         - Check queue");
    print("   /tasks          - List tasks");
    print("   /cancel <id>    - Cancel task\n");
  }

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
