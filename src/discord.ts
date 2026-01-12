import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
  EmbedBuilder,
  User,
  TextChannel,
} from "discord.js";
import { TaskQueue, TaskPriority } from "./db.js";
import { Notification, NotificationChannel } from "./notifier.js";
import { validatePrompt, validateProjectPath } from "./validation.js";
import { getLogger } from "./logger.js";

const log = getLogger("discord");

export interface DiscordConfig {
  token: string;
  notifyUserId?: string;
  notifyChannelId?: string;
  allowedUserIds?: string[];
  allowedChannelIds?: string[];
}

export class DiscordBot implements NotificationChannel {
  private client: Client;
  private queue: TaskQueue;
  private config: DiscordConfig;
  private ready = false;

  constructor(queue: TaskQueue, config: DiscordConfig) {
    this.queue = queue;
    this.config = config;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });
  }

  async start(): Promise<void> {
    await this.registerCommands();

    this.client.on("ready", () => {
      log.info("Bot logged in", { tag: this.client.user?.tag });
      this.ready = true;
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleCommand(interaction);
    });

    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  private async registerCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName("task")
        .setDescription("Submit a new task for the AI to work on")
        .addStringOption((opt) =>
          opt.setName("prompt").setDescription("What should the AI do?").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("project").setDescription("Project path (optional)")
        )
        .addStringOption((opt) =>
          opt
            .setName("priority")
            .setDescription("Task priority")
            .addChoices(
              { name: "High", value: "high" },
              { name: "Medium", value: "medium" },
              { name: "Low", value: "low" }
            )
        ),

      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Check queue status and running tasks"),

      new SlashCommandBuilder()
        .setName("tasks")
        .setDescription("List recent tasks")
        .addStringOption((opt) =>
          opt
            .setName("filter")
            .setDescription("Filter by status")
            .addChoices(
              { name: "All", value: "all" },
              { name: "Pending", value: "pending" },
              { name: "Running", value: "running" },
              { name: "Done", value: "done" },
              { name: "Failed", value: "failed" }
            )
        ),

      new SlashCommandBuilder()
        .setName("cancel")
        .setDescription("Cancel a pending task")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("Task ID to cancel").setRequired(true)
        ),
    ];

    const rest = new REST({ version: "10" }).setToken(this.config.token);

    const clientId = Buffer.from(this.config.token.split(".")[0], "base64").toString();

    await rest.put(Routes.applicationCommands(clientId), {
      body: commands.map((c) => c.toJSON()),
    });

    log.info("Slash commands registered");
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.isAllowed(interaction)) {
      await interaction.reply({ 
        content: "You don't have permission to use this bot.", 
        flags: 64 
      });
      return;
    }

    try {
      await interaction.deferReply();
      
      switch (interaction.commandName) {
        case "task":
          await this.handleTask(interaction);
          break;
        case "status":
          await this.handleStatus(interaction);
          break;
        case "tasks":
          await this.handleTasks(interaction);
          break;
        case "cancel":
          await this.handleCancel(interaction);
          break;
      }
    } catch (error) {
      log.error("Command error", { command: interaction.commandName, error: String(error) });
      try {
        const msg = error instanceof Error ? error.message : "Unknown error";
        await interaction.editReply({ content: `Error: ${msg}` });
      } catch {
        log.debug("Failed to send error response, interaction likely expired");
      }
    }
  }

  private isAllowed(interaction: ChatInputCommandInteraction): boolean {
    const { allowedUserIds, allowedChannelIds } = this.config;
    
    if (!allowedUserIds?.length && !allowedChannelIds?.length) {
      return true;
    }
    
    if (allowedUserIds?.includes(interaction.user.id)) {
      return true;
    }
    
    if (allowedChannelIds?.includes(interaction.channelId)) {
      return true;
    }
    
    return false;
  }

  private async handleTask(interaction: ChatInputCommandInteraction): Promise<void> {
    const prompt = interaction.options.getString("prompt", true);
    const project = interaction.options.getString("project") || undefined;
    const priority = (interaction.options.getString("priority") || "medium") as TaskPriority;

    const promptValidation = validatePrompt(prompt);
    if (!promptValidation.valid) {
      await interaction.editReply({ content: promptValidation.error });
      return;
    }

    const pathValidation = validateProjectPath(project);
    if (!pathValidation.valid) {
      await interaction.editReply({ content: pathValidation.error });
      return;
    }

    const recentTasks = this.queue.list(undefined, 10);
    const isDuplicate = recentTasks.some(
      (t) => t.prompt === prompt && 
             Date.now() - new Date(t.created_at).getTime() < 30000
    );

    if (isDuplicate) {
      await interaction.editReply({ content: "This task was already submitted. Check /status for progress." });
      return;
    }

    const task = this.queue.create({
      prompt,
      project_path: project,
      priority,
      created_by: interaction.user.id,
      source: "discord",
    });

    const embed = new EmbedBuilder()
      .setTitle("Task Queued")
      .setColor(0x00ff00)
      .addFields(
        { name: "ID", value: `#${task.id}`, inline: true },
        { name: "Priority", value: priority, inline: true },
        { name: "Prompt", value: prompt.slice(0, 200) + (prompt.length > 200 ? "..." : "") }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const stats = this.queue.stats();
    const running = this.queue.getRunning();

    const embed = new EmbedBuilder()
      .setTitle("Sleepless OpenCode Status")
      .setColor(0x0099ff)
      .addFields(
        { name: "Pending", value: String(stats.pending), inline: true },
        { name: "Running", value: String(stats.running), inline: true },
        { name: "Done", value: String(stats.done), inline: true },
        { name: "Failed", value: String(stats.failed), inline: true }
      )
      .setTimestamp();

    if (running) {
      embed.addFields({
        name: "Currently Running",
        value: `#${running.id}: ${running.prompt.slice(0, 100)}...`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  private async handleTasks(interaction: ChatInputCommandInteraction): Promise<void> {
    const filter = interaction.options.getString("filter") || "all";
    const tasks = filter === "all" 
      ? this.queue.list(undefined, 10)
      : this.queue.list(filter as any, 10);

    if (tasks.length === 0) {
      await interaction.editReply({ content: "No tasks found." });
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
      (t) => `${statusEmoji[t.status]} **#${t.id}** - ${t.prompt.slice(0, 50)}...`
    );

    const embed = new EmbedBuilder()
      .setTitle(`Tasks (${filter})`)
      .setDescription(lines.join("\n"))
      .setColor(0x0099ff)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  private async handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
    const id = interaction.options.getInteger("id", true);
    const success = this.queue.cancel(id);

    if (success) {
      await interaction.editReply({ content: `Task #${id} cancelled.` });
    } else {
      await interaction.editReply({ content: `Could not cancel task #${id}. It may not be pending.` });
    }
  }

  async send(notification: Notification): Promise<void> {
    if (!this.ready) return;

    const colors: Record<string, number> = {
      started: 0xffff00,
      completed: 0x00ff00,
      failed: 0xff0000,
    };

    const embed = new EmbedBuilder()
      .setTitle(`Task #${notification.task.id} - ${notification.type.toUpperCase()}`)
      .setColor(colors[notification.type])
      .addFields({ name: "Prompt", value: notification.task.prompt.slice(0, 200) })
      .setTimestamp();

    if (notification.result) {
      embed.addFields({
        name: "Result",
        value: notification.result.slice(0, 500) + (notification.result.length > 500 ? "..." : ""),
      });
    }

    if (notification.error) {
      embed.addFields({ name: "Error", value: notification.error.slice(0, 500) });
    }

    if (this.config.notifyUserId) {
      try {
        const user = await this.client.users.fetch(this.config.notifyUserId);
        await user.send({ embeds: [embed] });
      } catch (err) {
        log.error("Failed to DM user", { userId: this.config.notifyUserId, error: String(err) });
      }
    }

    if (this.config.notifyChannelId) {
      try {
        const channel = await this.client.channels.fetch(this.config.notifyChannelId);
        if (channel?.isTextBased()) {
          await (channel as TextChannel).send({ embeds: [embed] });
        }
      } catch (err) {
        log.error("Failed to send to channel", { channelId: this.config.notifyChannelId, error: String(err) });
      }
    }
  }
}
