import { spawn, spawnSync, ChildProcess } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { TaskQueue, Task } from "./db.js";
import { Notifier } from "./notifier.js";

interface AgentInfo {
  name: string;
  mode: string;
}

function discoverAgents(opencodePath?: string): AgentInfo[] {
  const opencodeBin = opencodePath || process.env.OPENCODE_PATH || "/root/.opencode/bin/opencode";
  
  try {
    const result = spawnSync(opencodeBin, ["agent", "list"], {
      encoding: "utf-8",
      timeout: 10000,
    });

    if (result.status !== 0) {
      return fallbackDiscoverAgents();
    }

    const agents: AgentInfo[] = [];
    const lines = result.stdout.split("\n");
    
    for (const line of lines) {
      const match = line.match(/^(\S+)\s+\((primary|subagent)\)/);
      if (match) {
        const [, name, mode] = match;
        if (name === "sleepless" || name === "sleepless-executor") continue;
        if (name === "compaction" || name === "summary" || name === "title") continue;
        agents.push({ name, mode });
      }
    }

    return agents;
  } catch {
    return fallbackDiscoverAgents();
  }
}

function fallbackDiscoverAgents(): AgentInfo[] {
  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  if (!existsSync(configPath)) {
    return [];
  }

  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const agents: AgentInfo[] = [];

    if (config.agent) {
      for (const [name, value] of Object.entries(config.agent)) {
        const agentConfig = value as Record<string, unknown>;
        if (agentConfig.disabled || agentConfig.disable) continue;
        if (name === "sleepless" || name === "sleepless-executor") continue;
        agents.push({
          name,
          mode: (agentConfig.mode as string) || "subagent",
        });
      }
    }

    return agents;
  } catch {
    return [];
  }
}

export interface DaemonConfig {
  pollIntervalMs: number;
  workspacePath: string;
  taskTimeoutMs?: number;
  iterationTimeoutMs?: number;
  model?: string;
  agent?: string;
  opencodePath?: string;
}

interface IterationResult {
  output: string;
  sessionId: string | null;
  isComplete: boolean;
  needsContinuation: boolean;
}

const COMPLETION_SIGNALS = [
  "task complete",
  "task completed",
  "successfully completed",
  "all done",
  "finished successfully",
  "completed successfully",
  "[TASK_COMPLETE]",
  "nothing left to do",
  "all steps completed",
];

const CONTINUATION_PROMPT = `[SYSTEM REMINDER - TODO CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Check todoread() for remaining items
- Mark current todo as in_progress
- Execute the action
- Mark todo as completed when done
- Proceed without asking for permission
- Do not stop until ALL todos are completed

When ALL todos show status "completed", say "[TASK_COMPLETE]" with a summary.`;

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

    const task = this.queue.getNextRetryable();
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

      const result = await this.runTaskWithLoop(task);

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
      const updatedTask = this.queue.get(task.id)!;
      
      const retryDelay = this.calculateRetryDelay(updatedTask.retry_count);
      const canRetry = this.queue.scheduleRetry(task.id, retryDelay);

      if (canRetry) {
        console.log(`[daemon] Task #${task.id} failed, scheduling retry ${updatedTask.retry_count + 1}/${updatedTask.max_retries} in ${retryDelay}s`);
        await this.notifier.notify({
          type: "failed",
          task: this.queue.get(task.id)!,
          message: `Task #${task.id} failed, retry scheduled in ${retryDelay}s`,
          error: errorMsg,
        });
      } else {
        this.queue.setFailed(task.id, errorMsg);
        console.error(`[daemon] Task #${task.id} failed permanently after ${updatedTask.retry_count} retries:`, errorMsg);
        await this.notifier.notify({
          type: "failed",
          task: this.queue.get(task.id)!,
          message: `Task #${task.id} failed permanently`,
          error: errorMsg,
        });
      }
    } finally {
      this.currentTask = null;
      this.currentProcess = null;
    }
  }

  private async runTaskWithLoop(task: Task): Promise<string> {
    const maxIterations = task.max_iterations || 10;
    let sessionId: string | null = null;
    let lastOutput = "";
    let isFirstIteration = true;

    this.queue.setRunning(task.id, `loop-${Date.now()}`);

    while (true) {
      const iteration = this.queue.incrementIteration(task.id);
      
      if (iteration > maxIterations) {
        console.log(`[daemon] Task #${task.id} hit max iterations (${maxIterations})`);
        return `Max iterations reached. Last output:\n${lastOutput}`;
      }

      console.log(`[daemon] Task #${task.id} iteration ${iteration}/${maxIterations}`);

      const prompt = isFirstIteration 
        ? this.buildInitialPrompt(task.prompt)
        : CONTINUATION_PROMPT;

      const result = await this.runSingleIteration(task, prompt, sessionId);
      
      lastOutput = result.output;
      sessionId = result.sessionId;
      isFirstIteration = false;

      if (sessionId) {
        this.queue.updateSessionId(task.id, sessionId);
      }

      if (result.isComplete) {
        console.log(`[daemon] Task #${task.id} signaled completion at iteration ${iteration}`);
        return result.output;
      }

      if (!result.needsContinuation) {
        console.log(`[daemon] Task #${task.id} appears done (no continuation needed)`);
        return result.output;
      }

      await this.sleep(2000);
    }
  }

  private buildInitialPrompt(userPrompt: string): string {
    const availableAgents = discoverAgents(this.config.opencodePath);
    const subagents = availableAgents.filter(a => a.mode === "subagent");
    
    let agentSection = "";
    if (subagents.length > 0) {
      const agentList = subagents
        .map(a => `  - @${a.name}`)
        .join("\n");
      
      agentSection = `
AVAILABLE SPECIALIST AGENTS:
${agentList}

DELEGATION RULES (IMPORTANT - read carefully):
1. **DO IT YOURSELF for simple tasks:**
   - Creating/editing single files
   - Running basic commands (git, npm, pip, etc.)
   - Simple scripts (< 50 lines)
   - File verification
   - Configuration changes

2. **DELEGATE ONLY for complex tasks that need expertise:**
   - @code-builder: Multi-file projects, complex algorithms, full applications with tests
   - @devops-helper: Docker/K8s configs, CI/CD pipelines, infrastructure setup
   - @blog-writer: Full blog posts with research and formatting
   - @explore: Finding code patterns across large codebases
   - @librarian: Looking up external documentation and examples

3. **NEVER delegate if:**
   - The task takes less than 5 steps
   - You can do it with basic bash/file tools
   - It's just creating a simple file

When you DO delegate, use task tool with subagent_type parameter.
`;
    } else {
      agentSection = `
NO SPECIALIST AGENTS AVAILABLE:
Execute all tasks yourself using the available tools (bash, read, write, edit, etc.)
`;
    }

    return `${userPrompt}
${agentSection}
IMPORTANT INSTRUCTIONS:
- Work through this task step by step using todos
- Execute actions, don't just plan them
- Delegate to specialist agents when their expertise matches the task
- When ALL objectives are complete, say "[TASK_COMPLETE]" followed by a summary
- If you encounter errors, try to fix them and continue
- Do not stop until the task is fully complete or you've tried all reasonable approaches`;
  }

  private async runSingleIteration(
    task: Task, 
    prompt: string, 
    sessionId: string | null
  ): Promise<IterationResult> {
    const workDir = task.project_path || this.config.workspacePath;
    const timeoutMs = this.config.iterationTimeoutMs || 10 * 60 * 1000;
    const opencodeBin = this.config.opencodePath || process.env.OPENCODE_PATH || "/root/.opencode/bin/opencode";

    const args = ["run", "--format", "json"];

    if (sessionId) {
      args.push("--session", sessionId);
    } else {
      args.push("--title", `Sleepless Task #${task.id}`);
    }

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    if (this.config.agent) {
      args.push("--agent", this.config.agent);
    }

    args.push("--", prompt);

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let capturedSessionId: string | null = sessionId;

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
        const chunk = data.toString();
        stdout += chunk;
        
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.session?.id && !capturedSessionId) {
              capturedSessionId = event.session.id;
            }
          } catch {}
        }
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        if (timedOut) {
          reject(new Error(`Iteration timed out after ${timeoutMs / 1000}s`));
          return;
        }

        if (code !== 0 && code !== null) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr || stdout}`));
          return;
        }

        const output = this.parseOpenCodeOutput(stdout);
        const isComplete = this.detectCompletion(output);
        const needsContinuation = this.detectContinuationNeeded(output, stdout);

        resolve({
          output,
          sessionId: capturedSessionId,
          isComplete,
          needsContinuation: !isComplete && needsContinuation,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        reject(new Error(`Failed to spawn OpenCode: ${err.message}`));
      });

      proc.stdin?.end();
    });
  }

  private detectCompletion(output: string): boolean {
    const lowerOutput = output.toLowerCase();
    return COMPLETION_SIGNALS.some(signal => lowerOutput.includes(signal.toLowerCase()));
  }

  private detectContinuationNeeded(output: string, rawOutput: string): boolean {
    const hasToolCalls = rawOutput.includes('"type":"tool_call"') || 
                         rawOutput.includes('"type":"tool_result"');
    
    const lowerOutput = output.toLowerCase();
    const planningPhrases = [
      "i will", "i'll", "let me", "first,", "next,", "then,",
      "step 1", "step 2", "here's my plan", "i need to",
      "working on", "processing", "executing"
    ];
    const hasPlanningLanguage = planningPhrases.some(p => lowerOutput.includes(p));

    const questionPhrases = ["should i", "would you like", "do you want"];
    const hasQuestion = questionPhrases.some(p => lowerOutput.includes(p));

    return hasToolCalls || (hasPlanningLanguage && !hasQuestion);
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
      return textParts.join("\n\n");
    }

    if (output.trim()) {
      return output.trim().slice(0, 4000);
    }

    return "Task completed (no output captured)";
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculateRetryDelay(retryCount: number): number {
    const baseDelay = 30;
    const maxDelay = 600;
    const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
    return delay;
  }

  getCurrentTask(): Task | null {
    return this.currentTask;
  }
}
