#!/usr/bin/env node
import { createInterface } from "readline";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

function printHeader(title: string) {
  print("");
  print("=".repeat(50));
  print(`  ${title}`);
  print("=".repeat(50));
  print("");
}

function printSection(title: string) {
  print("");
  print(`--- ${title} ---`);
  print("");
}

interface AgentInfo {
  name: string;
  mode: string;
  description?: string;
}

function discoverAgents(): AgentInfo[] {
  const opencodeBin = process.env.OPENCODE_PATH || 
    join(homedir(), ".opencode", "bin", "opencode");
  
  const agents: AgentInfo[] = [];
  const seen = new Set<string>();
  
  try {
    const result = spawnSync(opencodeBin, ["agent", "list"], {
      encoding: "utf-8",
      timeout: 10000,
    });

    if (result.status === 0) {
      for (const line of result.stdout.split("\n")) {
        const match = line.match(/^(\S+)\s+\((primary|subagent)\)/);
        if (match) {
          const [, name, mode] = match;
          if (seen.has(name)) continue;
          if (["compaction", "summary", "title"].includes(name)) continue;
          seen.add(name);
          agents.push({ name, mode });
        }
      }
    }
  } catch {}

  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.agent) {
        for (const [name, value] of Object.entries(config.agent)) {
          if (seen.has(name)) continue;
          const agentConfig = value as Record<string, unknown>;
          if (agentConfig.disabled || agentConfig.disable) continue;
          if (["compaction", "summary", "title"].includes(name)) continue;
          seen.add(name);
          agents.push({
            name,
            mode: (agentConfig.mode as string) || "subagent",
            description: agentConfig.description as string | undefined,
          });
        }
      }
    } catch {}
  }

  return agents;
}

function getOpencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

function addMcpToConfig(dataDir: string): boolean {
  const configPath = getOpencodeConfigPath();
  
  if (!existsSync(configPath)) {
    print("Warning: opencode.json not found at " + configPath);
    print("You'll need to add the MCP manually after installing OpenCode.");
    return false;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    
    const distPath = join(__dirname, "mcp-server.js");
    const wrapperPath = join(dirname(__dirname), "mcp-wrapper.sh");
    
    const wrapperContent = `#!/bin/bash
export SLEEPLESS_DATA_DIR="${dataDir}"
exec node "${distPath}" "$@"
`;
    writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
    
    config.mcp = config.mcp || {};
    config.mcp.sleepless = {
      type: "local",
      command: [wrapperPath],
      enabled: true,
    };
    
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    print("Added sleepless MCP to OpenCode config");
    return true;
  } catch (err) {
    print(`Warning: Could not update opencode.json: ${err}`);
    return false;
  }
}

async function main() {
  printHeader("sleepless-opencode Setup");
  
  print("This wizard will configure sleepless-opencode for background task processing.");
  print("You'll be able to queue tasks via Discord, Slack, or directly from OpenCode.");

  printSection("Agent Selection");
  
  print("Which agent should execute your background tasks?");
  print("This can be any primary agent from OpenCode or your plugins.");
  print("");
  
  const agents = discoverAgents();
  const primaryAgents = agents.filter(a => a.mode === "primary");
  
  if (primaryAgents.length === 0) {
    print("No agents found. The daemon will use OpenCode's default agent.");
  } else {
    print("Available agents:");
    print("");
    primaryAgents.forEach((a, i) => {
      const desc = a.description ? ` - ${a.description}` : "";
      print(`  ${i + 1}. ${a.name}${desc}`);
    });
    print("");
    print(`Press Enter to use your default agent (recommended)`);
    print("");
  }

  const config: Record<string, string> = {};
  
  if (primaryAgents.length > 0) {
    const agentChoice = await question(`Select agent [default]: `);
    const agentIndex = parseInt(agentChoice, 10) - 1;
    
    if (agentIndex >= 0 && agentIndex < primaryAgents.length) {
      config.OPENCODE_AGENT = primaryAgents[agentIndex].name;
      print(`Selected: ${config.OPENCODE_AGENT}`);
    } else {
      print("Using your default agent");
    }
  }

  printSection("Notification Channel");
  
  print("How do you want to receive task notifications and submit tasks?");
  print("");
  print("  1. Discord bot (recommended)");
  print("  2. Slack bot");
  print("  3. Both Discord and Slack");
  print("");
  
  const channelChoice = await question("Choice [1]: ") || "1";
  
  const useDiscord = channelChoice === "1" || channelChoice === "3";
  const useSlack = channelChoice === "2" || channelChoice === "3";

  if (useDiscord) {
    printSection("Discord Bot Setup");
    
    print("To create a Discord bot:");
    print("");
    print("1. Go to https://discord.com/developers/applications");
    print("2. Click 'New Application', give it a name");
    print("3. Go to 'Bot' tab -> click 'Add Bot'");
    print("4. Click 'Reset Token' and copy the token");
    print("5. Scroll down and enable 'Message Content Intent'");
    print("6. Go to 'OAuth2' -> 'URL Generator'");
    print("   - Check 'bot' and 'applications.commands' under Scopes");
    print("   - Check 'Send Messages' and 'Use Slash Commands' under Bot Permissions");
    print("7. Copy the generated URL, open it to invite the bot to your server");
    print("");

    config.DISCORD_BOT_TOKEN = await question("Discord Bot Token: ");

    if (!config.DISCORD_BOT_TOKEN) {
      print("Error: Discord token is required.");
      rl.close();
      process.exit(1);
    }

    print("");
    print("Where should task notifications be sent?");
    print("  1. Direct Message to you (private)");
    print("  2. A specific channel (visible to others)");
    print("  3. Both");
    print("");
    
    const notifyMethod = await question("Choice [1]: ") || "1";

    if (notifyMethod === "2" || notifyMethod === "3") {
      print("");
      print("To get a Channel ID:");
      print("  1. Enable Developer Mode: User Settings -> Advanced -> Developer Mode");
      print("  2. Right-click the channel -> Copy ID");
      config.DISCORD_NOTIFICATION_CHANNEL_ID = await question("Channel ID: ");
    }

    if (notifyMethod === "1" || notifyMethod === "3") {
      print("");
      print("To get your User ID:");
      print("  Right-click your name in Discord -> Copy ID");
      config.DISCORD_NOTIFICATION_USER_ID = await question("Your User ID: ");
    }

  }

  if (useSlack) {
    printSection("Slack Bot Setup");
    
    print("To create a Slack bot:");
    print("");
    print("1. Go to https://api.slack.com/apps");
    print("2. Click 'Create New App' -> 'From scratch'");
    print("3. Settings -> Socket Mode -> Enable, generate App Token (xapp-...)");
    print("4. OAuth & Permissions -> Add Bot Token Scopes: chat:write, commands");
    print("5. Slash Commands -> Create: /task, /status, /tasks, /cancel");
    print("6. Install to Workspace");
    print("7. Copy Bot User OAuth Token (xoxb-...)");
    print("");

    config.SLACK_BOT_TOKEN = await question("Slack Bot Token (xoxb-...): ");
    config.SLACK_APP_TOKEN = await question("Slack App Token (xapp-...): ");

    if (!config.SLACK_BOT_TOKEN || !config.SLACK_APP_TOKEN) {
      print("Error: Both Slack tokens are required.");
      rl.close();
      process.exit(1);
    }

    config.SLACK_NOTIFICATION_CHANNEL = await question("Notification channel (e.g., #general): ");
  }

  const defaultDataDir = join(homedir(), ".sleepless-opencode");
  config.SLEEPLESS_DATA_DIR = defaultDataDir;

  print("");
  const advancedSettings = await question("Configure advanced settings? (y/N): ");
  
  if (advancedSettings.toLowerCase() === "y") {
    printSection("Advanced Settings");
    
    print("Data directory: where task queue and results are stored");
    const customDataDir = await question(`Data directory [${defaultDataDir}]: `);
    if (customDataDir) config.SLEEPLESS_DATA_DIR = customDataDir;

    print("");
    print("Workspace: default project path for tasks without a specific path");
    const workspace = await question(`Workspace path [${process.cwd()}]: `);
    if (workspace) config.OPENCODE_WORKSPACE = workspace;

    print("");
    const taskTimeout = await question("Task timeout in minutes [30]: ");
    if (taskTimeout) config.TASK_TIMEOUT_MS = String(parseInt(taskTimeout, 10) * 60 * 1000);

    const healthPort = await question("Health endpoint port [9090]: ");
    if (healthPort) config.HEALTH_PORT = healthPort;
    
    print("");
    const useWebhook = await question("Set up webhook notifications? (y/N): ");
    if (useWebhook.toLowerCase() === "y") {
      print("");
      print("Webhooks send HTTP POST to your URL when tasks complete.");
      config.WEBHOOK_URL = await question("Webhook URL: ");
      
      if (config.WEBHOOK_URL) {
        const webhookSecret = await question("Webhook secret for HMAC signing (optional): ");
        if (webhookSecret) config.WEBHOOK_SECRET = webhookSecret;
      }
    }
  }

  printSection("Writing Configuration");

  const dataDir = config.SLEEPLESS_DATA_DIR;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    print(`Created data directory: ${dataDir}`);
  }

  const envContent = Object.entries(config)
    .filter(([_, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  writeFileSync(".env", envContent + "\n");
  print("Created .env file");

  print("");
  print("Setting up MCP integration...");
  const mcpSuccess = addMcpToConfig(dataDir);

  printHeader("Setup Complete!");

  print("Start the daemon:");
  print("");
  print("  npm start");
  print("");
  print("Or run in background:");
  print("");
  print("  tmux new-session -d -s sleepless 'npm start'");
  print("");

  if (useDiscord) {
    print("Discord commands (available in ~1 minute):");
    print("  /task prompt:<description>  - Queue a new task");
    print("  /status                     - Check queue status");
    print("  /tasks                      - List recent tasks");
    print("  /cancel id:<number>         - Cancel a pending task");
    print("");
  }

  if (useSlack) {
    print("Slack commands:");
    print("  /task <description>  - Queue a new task");
    print("  /status              - Check queue status");
    print("  /tasks               - List recent tasks");
    print("  /cancel <id>         - Cancel a pending task");
    print("");
  }

  if (mcpSuccess) {
    print("OpenCode MCP tools (restart OpenCode first):");
    print("  sleepless_queue   - Queue a task");
    print("  sleepless_status  - Check status");
    print("  sleepless_list    - List tasks");
    print("  sleepless_result  - Get task result");
    print("");
    print("Example: \"Queue this for sleepless: write tests for auth module\"");
    print("");
  }

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
