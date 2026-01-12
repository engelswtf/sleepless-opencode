import { App } from "@slack/bolt";
import { TaskQueue, TaskPriority } from "./db.js";
import { Notification, NotificationChannel } from "./notifier.js";
import { validatePrompt } from "./validation.js";
import { getLogger } from "./logger.js";

const log = getLogger("slack");

export interface SlackConfig {
  botToken: string;
  appToken: string;
  notifyChannel?: string;
}

export class SlackBot implements NotificationChannel {
  private app: App;
  private queue: TaskQueue;
  private config: SlackConfig;

  constructor(queue: TaskQueue, config: SlackConfig) {
    this.queue = queue;
    this.config = config;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    this.registerCommands();
  }

  private registerCommands(): void {
    this.app.command("/task", async ({ command, ack, respond }) => {
      await ack();

      const parts = command.text.split(" -p ");
      const prompt = parts[0].trim();
      const priority = (parts[1]?.trim() as TaskPriority) || "medium";

      if (!prompt) {
        await respond("Usage: /task <prompt> [-p high|medium|low]");
        return;
      }

      const promptValidation = validatePrompt(prompt);
      if (!promptValidation.valid) {
        await respond(`❌ ${promptValidation.error}`);
        return;
      }

      const task = this.queue.create({
        prompt,
        priority: ["high", "medium", "low"].includes(priority) ? priority : "medium",
        created_by: command.user_id,
        source: "slack",
      });

      await respond({
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Task #${task.id} queued*\n_${prompt.slice(0, 100)}_\nPriority: ${task.priority}`,
            },
          },
        ],
      });
    });

    this.app.command("/status", async ({ ack, respond }) => {
      await ack();

      const stats = this.queue.stats();
      const running = this.queue.getRunning();

      let text = `*Queue Status*\n`;
      text += `⏳ Pending: ${stats.pending}\n`;
      text += `🔄 Running: ${stats.running}\n`;
      text += `✅ Done: ${stats.done}\n`;
      text += `❌ Failed: ${stats.failed}\n`;

      if (running) {
        text += `\n*Currently Running:* #${running.id} - ${running.prompt.slice(0, 50)}...`;
      }

      await respond({ text });
    });

    this.app.command("/tasks", async ({ ack, respond }) => {
      await ack();

      const tasks = this.queue.list(undefined, 10);

      if (tasks.length === 0) {
        await respond("No tasks found.");
        return;
      }

      const statusEmoji: Record<string, string> = {
        pending: "⏳",
        running: "🔄",
        done: "✅",
        failed: "❌",
        cancelled: "🚫",
      };

      const lines = tasks.map(
        (t) => `${statusEmoji[t.status]} *#${t.id}* - ${t.prompt.slice(0, 50)}...`
      );

      await respond({ text: lines.join("\n") });
    });

    this.app.command("/cancel", async ({ command, ack, respond }) => {
      await ack();

      const id = parseInt(command.text.trim(), 10);
      if (isNaN(id)) {
        await respond("Usage: /cancel <task_id>");
        return;
      }

      const success = this.queue.cancel(id);
      if (success) {
        await respond(`Task #${id} cancelled.`);
      } else {
        await respond(`Could not cancel task #${id}. It may not be pending.`);
      }
    });
  }

  async start(): Promise<void> {
    await this.app.start();
    log.info("Bot started");
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  async send(notification: Notification): Promise<void> {
    if (!this.config.notifyChannel) return;

    const emoji: Record<string, string> = {
      started: "🚀",
      completed: "✅",
      failed: "❌",
    };

    let text = `${emoji[notification.type]} *Task #${notification.task.id}* - ${notification.type.toUpperCase()}\n`;
    text += `_${notification.task.prompt.slice(0, 100)}_\n`;

    if (notification.result) {
      text += `\n*Result:*\n\`\`\`${notification.result.slice(0, 500)}\`\`\``;
    }

    if (notification.error) {
      text += `\n*Error:*\n\`\`\`${notification.error.slice(0, 500)}\`\`\``;
    }

    try {
      await this.app.client.chat.postMessage({
        channel: this.config.notifyChannel,
        text,
      });
    } catch (err) {
      log.error("Failed to send notification", { channel: this.config.notifyChannel, error: String(err) });
    }
  }
}
