import { spawn, spawnSync, ChildProcess } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { TaskQueue, Task } from "./db.js";
import { Notifier } from "./notifier.js";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";

interface AgentInfo {
  name: string;
  mode: string;
}

const TASK_TTL_MS = 30 * 60 * 1000;
const MIN_STABILITY_TIME_MS = 10 * 1000;
const MIN_IDLE_TIME_MS = 5000;
const STABLE_POLLS_REQUIRED = 3;

type ErrorType = 
  | "rate_limit"
  | "context_exceeded" 
  | "agent_not_found"
  | "tool_result_missing"
  | "thinking_block_error"
  | "timeout"
  | "unknown";

interface TaskProgress {
  toolCalls: number;
  lastTool?: string;
  lastMessage?: string;
  lastMessageAt?: Date;
  lastUpdate: Date;
}

interface TaskState {
  sessionId: string;
  startedAt: Date;
  lastMessageCount: number;
  stablePolls: number;
  progress: TaskProgress;
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
  maxConcurrent?: number;
}

interface IterationResult {
  output: string;
  sessionId: string | null;
  isComplete: boolean;
  needsContinuation: boolean;
}

const COMPLETION_SIGNALS = [
  "[TASK_COMPLETE]",
  "[task_complete]",
  "task complete",
  "task completed", 
  "successfully completed",
  "all done",
  "finished successfully",
  "completed successfully",
  "nothing left to do",
  "all steps completed",
  "all todos completed",
  "todos completed: ",
];

const STRONG_COMPLETION_SIGNALS = [
  "[TASK_COMPLETE]",
  "[task_complete]",
  "todos completed:",
  "all todos completed",
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
  
  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private abortController: AbortController | null = null;
  
  private taskStates: Map<number, TaskState> = new Map();
  private activeTasks: Set<number> = new Set();

  constructor(queue: TaskQueue, notifier: Notifier, config: DaemonConfig) {
    this.queue = queue;
    this.notifier = notifier;
    this.config = config;
  }

  private detectErrorType(error: unknown): ErrorType {
    const message = this.getErrorMessage(error);
    
    if (message.includes("rate") && message.includes("limit")) {
      return "rate_limit";
    }
    if (message.includes("context") && (message.includes("length") || message.includes("window") || message.includes("exceeded"))) {
      return "context_exceeded";
    }
    if (message.includes("agent") && (message.includes("not found") || message.includes("undefined"))) {
      return "agent_not_found";
    }
    if (message.includes("tool_use") && message.includes("tool_result")) {
      return "tool_result_missing";
    }
    if (message.includes("thinking") && (message.includes("block") || message.includes("disabled"))) {
      return "thinking_block_error";
    }
    if (message.includes("timeout") || message.includes("timed out")) {
      return "timeout";
    }
    return "unknown";
  }

  private getErrorMessage(error: unknown): string {
    if (!error) return "";
    if (typeof error === "string") return error.toLowerCase();
    
    const errorObj = error as Record<string, unknown>;
    const paths = [
      errorObj.message,
      errorObj.data,
      errorObj.error,
      (errorObj.data as Record<string, unknown>)?.message,
      (errorObj.error as Record<string, unknown>)?.message,
    ];
    
    for (const obj of paths) {
      if (typeof obj === "string" && obj.length > 0) {
        return obj.toLowerCase();
      }
    }
    
    try {
      return JSON.stringify(error).toLowerCase();
    } catch {
      return "";
    }
  }

  private async validateSessionHasOutput(sessionId: string, workDir: string): Promise<boolean> {
    if (!this.client) return true;
    
    try {
      const response = await this.client.session.messages({
        path: { id: sessionId },
        query: { directory: workDir },
      });
      
      const messages = response.data ?? [];
      
      const hasAssistantOrToolMessage = messages.some(
        (m: { info?: { role?: string } }) => 
          m.info?.role === "assistant" || m.info?.role === "tool"
      );
      
      if (!hasAssistantOrToolMessage) {
        return false;
      }
      
      const hasContent = messages.some((m: { info?: { role?: string }; parts?: Array<{ type?: string; text?: string; content?: unknown }> }) => {
        if (m.info?.role !== "assistant" && m.info?.role !== "tool") return false;
        const parts = m.parts ?? [];
        return parts.some((p) => 
          (p.type === "text" && p.text && p.text.trim().length > 0) ||
          (p.type === "reasoning" && p.text && p.text.trim().length > 0) ||
          p.type === "tool" ||
          (p.type === "tool_result" && p.content)
        );
      });
      
      return hasContent;
    } catch (error) {
      console.error("[daemon] Error validating session output:", error);
      return true;
    }
  }

  private async hasIncompleteTodos(sessionId: string): Promise<boolean> {
    if (!this.client) return false;
    
    try {
      const response = await this.client.session.todo({
        path: { id: sessionId },
      });
      const todos = (response.data ?? response) as Array<{ status: string }>;
      if (!todos || todos.length === 0) return false;
      
      return todos.some(t => t.status !== "completed" && t.status !== "cancelled");
    } catch {
      return false;
    }
  }

  private async recoverToolResultMissing(sessionId: string, workDir: string): Promise<boolean> {
    if (!this.client) return false;
    
    try {
      const messagesResult = await this.client.session.messages({
        path: { id: sessionId },
        query: { directory: workDir },
      });
      
      const messages = messagesResult.data ?? [];
      const assistantMessages = messages.filter(
        (m: { info?: { role?: string } }) => m.info?.role === "assistant"
      );
      
      if (assistantMessages.length === 0) return false;
      
      const lastAssistant = assistantMessages[assistantMessages.length - 1] as {
        parts?: Array<{ type?: string; id?: string; callID?: string }>
      };
      const parts = lastAssistant.parts ?? [];
      
      const toolUseIds = parts
        .filter((p) => p.type === "tool_use" || p.type === "tool")
        .map((p) => p.id || p.callID)
        .filter((id): id is string => !!id);
      
      if (toolUseIds.length === 0) return false;
      
      const toolResultParts = toolUseIds.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "Operation cancelled (session recovery)",
      }));
      
      await this.client.session.prompt({
        path: { id: sessionId },
        body: { parts: toolResultParts as unknown as Array<{ type: "text"; text: string }> },
        query: { directory: workDir },
      });
      
      console.log(`[daemon] Recovered tool_result_missing for session ${sessionId}`);
      return true;
    } catch (error) {
      console.error("[daemon] Failed to recover tool_result_missing:", error);
      return false;
    }
  }

  private pruneStaleTaskStates(): void {
    const now = Date.now();
    for (const [taskId, state] of this.taskStates.entries()) {
      const age = now - state.startedAt.getTime();
      if (age > TASK_TTL_MS) {
        console.log(`[daemon] Pruning stale task state for task #${taskId}`);
        this.taskStates.delete(taskId);
        this.activeTasks.delete(taskId);
      }
    }
  }

  private updateTaskProgress(
    taskId: number,
    messages: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string; tool?: string; name?: string }> }>
  ): TaskProgress {
    const state = this.taskStates.get(taskId);
    const progress: TaskProgress = state?.progress ?? {
      toolCalls: 0,
      lastUpdate: new Date(),
    };
    
    let toolCalls = 0;
    let lastTool: string | undefined;
    let lastMessage: string | undefined;
    
    for (const msg of messages) {
      if (msg.info?.role !== "assistant") continue;
      for (const part of msg.parts ?? []) {
        if (part.type === "tool_use" || part.type === "tool" || part.tool) {
          toolCalls++;
          lastTool = part.tool || part.name || "unknown";
        }
        if (part.type === "text" && part.text) {
          lastMessage = part.text;
        }
      }
    }
    
    progress.toolCalls = toolCalls;
    if (lastTool) progress.lastTool = lastTool;
    if (lastMessage) {
      progress.lastMessage = lastMessage;
      progress.lastMessageAt = new Date();
    }
    progress.lastUpdate = new Date();
    
    return progress;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[daemon] Starting sleepless-opencode daemon...");
    console.log(`[daemon] Workspace: ${this.config.workspacePath}`);
    console.log(`[daemon] Poll interval: ${this.config.pollIntervalMs}ms`);

    // Initialize OpenCode SDK server
    try {
      console.log("[daemon] Initializing OpenCode SDK server...");
      this.abortController = new AbortController();
      const opencode = await createOpencode({
        signal: this.abortController.signal,
        timeout: 30000,
      });
      this.client = opencode.client;
      this.server = opencode.server;
      console.log(`[daemon] OpenCode SDK server started at ${this.server.url}`);
    } catch (error) {
      console.error("[daemon] Failed to initialize OpenCode SDK, falling back to CLI mode:", error);
      // SDK init failed, we'll use CLI mode as fallback
    }

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
    if (this.server) {
      console.log("[daemon] Shutting down OpenCode SDK server...");
      this.server.close();
      this.server = null;
      this.client = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
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
      const errorType = this.detectErrorType(error);
      const updatedTask = this.queue.get(task.id)!;
      
      const state = this.taskStates.get(task.id);
      const sessionId = state?.sessionId || updatedTask.session_id;
      
      if (errorType === "tool_result_missing" && sessionId) {
        console.log(`[daemon] Attempting to recover tool_result_missing for task #${task.id}`);
        const workDir = task.project_path || this.config.workspacePath;
        const recovered = await this.recoverToolResultMissing(sessionId, workDir);
        if (recovered) {
          console.log(`[daemon] Recovery successful, task will continue`);
          return;
        }
      }
      
      const shouldRetry = errorType !== "agent_not_found" && errorType !== "context_exceeded";
      const retryDelay = this.calculateRetryDelay(updatedTask.retry_count);
      const canRetry = shouldRetry && this.queue.scheduleRetry(task.id, retryDelay);

      const errorDetails = `[${errorType}] ${errorMsg}`;
      
      if (canRetry) {
        console.log(`[daemon] Task #${task.id} failed (${errorType}), scheduling retry ${updatedTask.retry_count + 1}/${updatedTask.max_retries} in ${retryDelay}s`);
        await this.notifier.notify({
          type: "failed",
          task: this.queue.get(task.id)!,
          message: `Task #${task.id} failed (${errorType}), retry scheduled in ${retryDelay}s`,
          error: errorDetails,
        });
      } else {
        this.queue.setFailed(task.id, errorDetails, errorType);
        console.error(`[daemon] Task #${task.id} failed permanently (${errorType}) after ${updatedTask.retry_count} retries:`, errorMsg);
        await this.notifier.notify({
          type: "failed",
          task: this.queue.get(task.id)!,
          message: `Task #${task.id} failed permanently (${errorType})`,
          error: errorDetails,
        });
      }
    } finally {
      this.currentTask = null;
      this.currentProcess = null;
      this.taskStates.delete(task.id);
      this.activeTasks.delete(task.id);
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
    if (this.client) {
      return this.runSdkIteration(task, prompt, sessionId);
    }
    return this.runCliIteration(task, prompt, sessionId);
  }

  private async runSdkIteration(
    task: Task,
    prompt: string,
    sessionId: string | null
  ): Promise<IterationResult> {
    const client = this.client!;
    const timeoutMs = this.config.iterationTimeoutMs || 10 * 60 * 1000;
    const agent = this.config.agent || "sleepless-executor";
    const workDir = task.project_path || this.config.workspacePath;

    let currentSessionId = sessionId;

    if (!currentSessionId) {
      const createResult = await client.session.create({
        body: {
          title: `Sleepless Task #${task.id}`,
        },
        query: { directory: workDir },
      });
      if (createResult.error) {
        throw new Error(`Failed to create session: ${JSON.stringify(createResult.error)}`);
      }
      currentSessionId = createResult.data.id;
      console.log(`[daemon] Created session ${currentSessionId} for task #${task.id}`);
      
      this.taskStates.set(task.id, {
        sessionId: currentSessionId,
        startedAt: new Date(),
        lastMessageCount: 0,
        stablePolls: 0,
        progress: { toolCalls: 0, lastUpdate: new Date() },
      });
    }

    const promptResult = await client.session.prompt({
      path: { id: currentSessionId },
      body: {
        agent,
        parts: [{ type: "text", text: prompt }],
      },
      query: { directory: workDir },
    });

    if (promptResult.error) {
      const errorType = this.detectErrorType(promptResult.error);
      if (errorType === "agent_not_found") {
        throw new Error(`Agent "${agent}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.`);
      }
      throw new Error(`Failed to send prompt: ${JSON.stringify(promptResult.error)}`);
    }

    const iterationStartTime = Date.now();
    let state = this.taskStates.get(task.id);
    if (!state) {
      state = {
        sessionId: currentSessionId,
        startedAt: new Date(),
        lastMessageCount: 0,
        stablePolls: 0,
        progress: { toolCalls: 0, lastUpdate: new Date() },
      };
      this.taskStates.set(task.id, state);
    }
    
    while (Date.now() - iterationStartTime < timeoutMs) {
      await this.sleep(2000);
      
      this.pruneStaleTaskStates();
      
      const statusResult = await client.session.status({
        query: { directory: workDir },
      });
      
      const sessionStatus = statusResult.data?.[currentSessionId];
      const elapsedMs = Date.now() - state.startedAt.getTime();
      
      if (sessionStatus?.type === "idle") {
        if (elapsedMs < MIN_IDLE_TIME_MS) {
          console.log(`[daemon] Ignoring early session.idle, elapsed: ${elapsedMs}ms`);
          continue;
        }
        
        const hasValidOutput = await this.validateSessionHasOutput(currentSessionId, workDir);
        if (!hasValidOutput) {
          console.log(`[daemon] Session idle but no valid output yet, waiting...`);
          continue;
        }
        
        const hasIncompleteTodos = await this.hasIncompleteTodos(currentSessionId);
        if (hasIncompleteTodos) {
          console.log(`[daemon] Session idle but has incomplete todos, needs continuation`);
          const messagesResult = await client.session.messages({
            path: { id: currentSessionId },
            query: { directory: workDir },
          });
          const messages = messagesResult.data || [];
          const output = this.extractOutputFromMessages(messages);
          state.progress = this.updateTaskProgress(task.id, messages);
          
          return {
            output,
            sessionId: currentSessionId,
            isComplete: false,
            needsContinuation: true,
          };
        }
        
        const messagesResult = await client.session.messages({
          path: { id: currentSessionId },
          query: { directory: workDir },
        });
        
        const messages = messagesResult.data || [];
        const output = this.extractOutputFromMessages(messages);
        const isComplete = this.detectCompletion(output);
        const needsContinuation = this.detectContinuationNeededFromMessages(messages, output);
        state.progress = this.updateTaskProgress(task.id, messages);
        this.queue.updateProgress(task.id, state.progress);
        
        return {
          output,
          sessionId: currentSessionId,
          isComplete: isComplete || !needsContinuation,
          needsContinuation: !isComplete && needsContinuation,
        };
      }
      
      const messagesResult = await client.session.messages({
        path: { id: currentSessionId },
        query: { directory: workDir },
      });
      const messages = messagesResult.data || [];
      const currentMessageCount = messages.length;
      
      state.progress = this.updateTaskProgress(task.id, messages);
      this.queue.updateProgress(task.id, state.progress);
      
      if (elapsedMs >= MIN_STABILITY_TIME_MS) {
        if (currentMessageCount === state.lastMessageCount) {
          state.stablePolls++;
          if (state.stablePolls >= STABLE_POLLS_REQUIRED) {
            const hasValidOutput = await this.validateSessionHasOutput(currentSessionId, workDir);
            if (!hasValidOutput) {
              console.log(`[daemon] Stability reached but no valid output, waiting...`);
              continue;
            }
            
            const hasIncompleteTodos = await this.hasIncompleteTodos(currentSessionId);
            if (hasIncompleteTodos) {
              console.log(`[daemon] Stability reached but has incomplete todos, needs continuation`);
              const output = this.extractOutputFromMessages(messages);
              return {
                output,
                sessionId: currentSessionId,
                isComplete: false,
                needsContinuation: true,
              };
            }
            
            const output = this.extractOutputFromMessages(messages);
            const isComplete = this.detectCompletion(output);
            
            console.log(`[daemon] Session ${currentSessionId} stable after ${state.stablePolls} polls`);
            return {
              output,
              sessionId: currentSessionId,
              isComplete: true,
              needsContinuation: false,
            };
          }
        } else {
          state.stablePolls = 0;
        }
      }
      state.lastMessageCount = currentMessageCount;
    }
    
    throw new Error(`SDK iteration timed out after ${timeoutMs / 1000}s`);
  }

  private extractOutputFromMessages(messages: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>): string {
    const textParts: string[] = [];
    
    for (const msg of messages) {
      if (msg.info?.role !== "assistant") continue;
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          textParts.push(part.text);
        }
      }
    }
    
    if (textParts.length > 0) {
      return textParts.join("\n\n");
    }
    return "Task completed (no output captured)";
  }

  private detectContinuationNeededFromMessages(
    messages: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string; tool?: string }> }>,
    output: string
  ): boolean {
    if (this.detectCompletion(output)) {
      return false;
    }
    
    let hasToolCalls = false;
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "tool" || part.tool) {
          hasToolCalls = true;
          break;
        }
      }
    }
    
    const lowerOutput = output.toLowerCase();
    const stoppingPhrases = [
      "waiting for", "need more information", "please provide",
      "could you clarify", "what would you like", "should i proceed"
    ];
    const needsInput = stoppingPhrases.some(p => lowerOutput.includes(p));
    if (needsInput) return false;
    
    const planningPhrases = [
      "i will", "i'll", "let me", "first,", "next,", "then,",
      "step 1", "step 2", "here's my plan", "i need to",
      "working on", "processing", "executing", "creating",
      "todo", "in_progress", "pending"
    ];
    const hasPlanningLanguage = planningPhrases.some(p => lowerOutput.includes(p));

    return hasToolCalls || hasPlanningLanguage;
  }

  private async runCliIteration(
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
    
    // Strong signals are definitive - task is complete
    const hasStrongSignal = STRONG_COMPLETION_SIGNALS.some(
      signal => lowerOutput.includes(signal.toLowerCase())
    );
    if (hasStrongSignal) return true;
    
    // Weak signals need additional context
    const hasWeakSignal = COMPLETION_SIGNALS.some(
      signal => lowerOutput.includes(signal.toLowerCase())
    );
    if (!hasWeakSignal) return false;
    
    // If weak signal present, check it's not just planning language
    const planningPhrases = ["i will", "i'll", "let me", "next i", "then i"];
    const hasPlanningAfterCompletion = planningPhrases.some(p => {
      const completionIdx = lowerOutput.lastIndexOf("complete");
      const planningIdx = lowerOutput.lastIndexOf(p);
      return planningIdx > completionIdx && completionIdx >= 0;
    });
    
    return !hasPlanningAfterCompletion;
  }

  private detectContinuationNeeded(output: string, rawOutput: string): boolean {
    // If we already detected completion, don't continue
    if (this.detectCompletion(output)) {
      return false;
    }
    
    const hasToolCalls = rawOutput.includes('"type":"tool_call"') || 
                         rawOutput.includes('"type":"tool_result"');
    
    const lowerOutput = output.toLowerCase();
    
    // Check for explicit "waiting" or "need input" signals - stop if found
    const stoppingPhrases = [
      "waiting for", "need more information", "please provide",
      "could you clarify", "what would you like", "should i proceed"
    ];
    const needsInput = stoppingPhrases.some(p => lowerOutput.includes(p));
    if (needsInput) return false;
    
    // Check for active work indicators
    const planningPhrases = [
      "i will", "i'll", "let me", "first,", "next,", "then,",
      "step 1", "step 2", "here's my plan", "i need to",
      "working on", "processing", "executing", "creating",
      "todo", "in_progress", "pending"
    ];
    const hasPlanningLanguage = planningPhrases.some(p => lowerOutput.includes(p));

    return hasToolCalls || hasPlanningLanguage;
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
