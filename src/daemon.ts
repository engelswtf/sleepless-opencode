import { createOpencode } from "@opencode-ai/sdk";
import { TaskQueue, Task } from "./db.js";
import { Notifier } from "./notifier.js";

export interface DaemonConfig {
  pollIntervalMs: number;
  workspacePath: string;
  opencodePort?: number;
}

export class Daemon {
  private queue: TaskQueue;
  private notifier: Notifier;
  private config: DaemonConfig;
  private running = false;
  private currentTask: Task | null = null;

  constructor(queue: TaskQueue, notifier: Notifier, config: DaemonConfig) {
    this.queue = queue;
    this.notifier = notifier;
    this.config = config;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[daemon] Starting sleepless-opencode daemon...");
    console.log(`[daemon] Workspace: ${this.config.workspacePath}`);
    console.log(`[daemon] Poll interval: ${this.config.pollIntervalMs}ms`);

    while (this.running) {
      try {
        await this.processNext();
      } catch (error) {
        console.error("[daemon] Error processing task:", error);
      }

      await this.sleep(this.config.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
    console.log("[daemon] Stopping daemon...");
  }

  private async processNext(): Promise<void> {
    const runningTask = this.queue.getRunning();
    if (runningTask) {
      return;
    }

    const task = this.queue.getNext();
    if (!task) {
      return;
    }

    this.currentTask = task;
    console.log(`[daemon] Processing task #${task.id}: ${task.prompt.slice(0, 50)}...`);

    try {
      await this.notifier.notify({
        type: "started",
        task,
        message: `Started task #${task.id}`,
      });

      const result = await this.runTask(task);

      this.queue.setDone(task.id, result);

      await this.notifier.notify({
        type: "completed",
        task: this.queue.get(task.id)!,
        message: `Completed task #${task.id}`,
        result,
      });

      console.log(`[daemon] Task #${task.id} completed`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.queue.setFailed(task.id, errorMsg);

      await this.notifier.notify({
        type: "failed",
        task: this.queue.get(task.id)!,
        message: `Task #${task.id} failed`,
        error: errorMsg,
      });

      console.error(`[daemon] Task #${task.id} failed:`, errorMsg);
    } finally {
      this.currentTask = null;
    }
  }

  private async runTask(task: Task): Promise<string> {
    const workDir = task.project_path || this.config.workspacePath;

    const { client, server } = await createOpencode({
      port: this.config.opencodePort,
      config: {},
    });

    try {
      const session = await client.session.create({
        body: { title: `Sleepless Task #${task.id}` },
      });

      this.queue.setRunning(task.id, session.data!.id);

      const response = await client.session.prompt({
        path: { id: session.data!.id },
        body: {
          parts: [{ type: "text", text: task.prompt }],
        },
      });

      const events = await client.event.subscribe();
      for await (const event of events.stream) {
        if (event.type === "session.idle" || event.type === "session.error") {
          break;
        }
      }

      const messages = await client.session.messages({
        path: { id: session.data!.id },
      });

      const lastAssistantMessage = messages.data
        ?.filter((m: any) => m.info.role === "assistant")
        .pop();

      const resultText = lastAssistantMessage?.parts
        ?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n") || "Task completed";

      return resultText;
    } finally {
      server.close();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getCurrentTask(): Task | null {
    return this.currentTask;
  }
}
