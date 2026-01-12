import { spawn, ChildProcess } from "child_process";
import { TaskQueue, Task } from "./db.js";
import { Notifier } from "./notifier.js";

export interface DaemonConfig {
  pollIntervalMs: number;
  workspacePath: string;
  taskTimeoutMs?: number;
  model?: string;
  opencodePath?: string;
}

export class Daemon {
  private queue: TaskQueue;
  private notifier: Notifier;
  private config: DaemonConfig;
  private running = false;
  private currentTask: Task | null = null;
  private currentProcess: ChildProcess | null = null;

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

    const stuckTask = this.queue.getRunning();
    if (stuckTask) {
      console.log(`[daemon] Found task #${stuckTask.id} stuck in running state, resetting to pending`);
      this.queue.resetToPending(stuckTask.id);
    }

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
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
    }
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
      this.currentProcess = null;
    }
  }

  private async runTask(task: Task): Promise<string> {
    const workDir = task.project_path || this.config.workspacePath;
    const timeoutMs = this.config.taskTimeoutMs || 30 * 60 * 1000;
    const opencodeBin = this.config.opencodePath || process.env.OPENCODE_PATH || "/root/.opencode/bin/opencode";

    const args = [
      "run",
      "--format", "json",
      "--title", `Sleepless Task #${task.id}`,
    ];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    args.push("--", task.prompt);

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      this.queue.setRunning(task.id, `cli-${Date.now()}`);

      const proc = spawn(opencodeBin, args, {
        cwd: workDir,
        env: {
          ...process.env,
          CI: "true",
          OPENCODE_NONINTERACTIVE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.currentProcess = proc;

      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5000);
      }, timeoutMs);

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (timedOut) {
          reject(new Error(`Task timed out after ${timeoutMs / 1000}s`));
          return;
        }

        if (code !== 0 && code !== null) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr || stdout}`));
          return;
        }

        const result = this.parseOpenCodeOutput(stdout);
        resolve(result);
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        reject(new Error(`Failed to spawn OpenCode: ${err.message}`));
      });

      proc.stdin?.end();
    });
  }

  private parseOpenCodeOutput(output: string): string {
    const lines = output.trim().split("\n").filter(Boolean);
    const textParts: string[] = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "text" && event.part?.text) {
          textParts.push(event.part.text);
        }
        if (event.type === "part" && event.part?.type === "text" && event.part?.text) {
          textParts.push(event.part.text);
        }
        if (event.type === "message" && event.message?.role === "assistant") {
          const parts = event.message.parts || [];
          for (const part of parts) {
            if (part.type === "text" && part.text) {
              textParts.push(part.text);
            }
          }
        }
      } catch {
        continue;
      }
    }

    if (textParts.length > 0) {
      return textParts[textParts.length - 1];
    }

    if (output.trim()) {
      return output.trim().slice(0, 4000);
    }

    return "Task completed (no output captured)";
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getCurrentTask(): Task | null {
    return this.currentTask;
  }
}
