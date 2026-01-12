#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDb, TaskQueue, TaskPriority } from "./db.js";

const db = initDb();
const queue = new TaskQueue(db);

const server = new Server(
  { name: "sleepless", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "sleepless_queue",
      description: "Queue a task for background processing. Runs even after you close OpenCode. Default: urgent priority (runs next).",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The task prompt - what should the AI do?",
          },
          project_path: {
            type: "string",
            description: "Optional: project directory path",
          },
          priority: {
            type: "string",
            enum: ["urgent", "high", "medium", "low"],
            description: "Task priority (default: urgent)",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "sleepless_status",
      description: "Check sleepless queue status or specific task",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "number",
            description: "Optional: specific task ID to check",
          },
        },
      },
    },
    {
      name: "sleepless_list",
      description: "List queued tasks",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "running", "done", "failed", "all"],
            description: "Filter by status (default: all)",
          },
          limit: {
            type: "number",
            description: "Max tasks to return (default: 10)",
          },
        },
      },
    },
    {
      name: "sleepless_cancel",
      description: "Cancel a pending task",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "number",
            description: "Task ID to cancel",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "sleepless_result",
      description: "Get full result of a completed task",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "number",
            description: "Task ID to get result for",
          },
        },
        required: ["task_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "sleepless_queue": {
      const prompt = args?.prompt as string;
      const project_path = args?.project_path as string | undefined;
      const priority = (args?.priority as TaskPriority) || "urgent";

      const task = queue.create({
        prompt,
        project_path,
        priority,
        source: "cli",
      });

      return {
        content: [
          {
            type: "text",
            text: `Task #${task.id} queued (${priority} priority)\nPrompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
          },
        ],
      };
    }

    case "sleepless_status": {
      const taskId = args?.task_id as number | undefined;

      if (taskId) {
        const task = queue.get(taskId);
        if (!task) {
          return { content: [{ type: "text", text: `Task #${taskId} not found` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: `Task #${task.id} [${task.status}] (${task.priority})\nPrompt: ${task.prompt.slice(0, 200)}${task.result ? `\nResult: ${task.result.slice(0, 500)}` : ""}${task.error ? `\nError: ${task.error}` : ""}`,
            },
          ],
        };
      }

      const stats = queue.stats();
      const running = queue.getRunning();

      let text = `Queue Status:\n  Pending: ${stats.pending}\n  Running: ${stats.running}\n  Done: ${stats.done}\n  Failed: ${stats.failed}`;
      if (running) {
        text += `\n\nCurrently running: #${running.id} - ${running.prompt.slice(0, 50)}...`;
      }

      return { content: [{ type: "text", text }] };
    }

    case "sleepless_list": {
      const status = args?.status as string | undefined;
      const limit = (args?.limit as number) || 10;

      const tasks = status && status !== "all"
        ? queue.list(status as any, limit)
        : queue.list(undefined, limit);

      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks found" }] };
      }

      const lines = tasks.map(
        (t) => `#${t.id} [${t.status}] (${t.priority}) ${t.prompt.slice(0, 50)}...`
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "sleepless_cancel": {
      const taskId = args?.task_id as number;
      const success = queue.cancel(taskId);

      return {
        content: [
          {
            type: "text",
            text: success
              ? `Task #${taskId} cancelled`
              : `Could not cancel task #${taskId} (not pending or not found)`,
          },
        ],
      };
    }

    case "sleepless_result": {
      const taskId = args?.task_id as number;
      const task = queue.get(taskId);

      if (!task) {
        return { content: [{ type: "text", text: `Task #${taskId} not found` }] };
      }

      return {
        content: [
          {
            type: "text",
            text: `Task #${task.id} [${task.status}]\nPrompt: ${task.prompt}\n\n${task.result ? `Result:\n${task.result}` : ""}${task.error ? `Error:\n${task.error}` : ""}${task.status === "pending" || task.status === "running" ? "Task not completed yet" : ""}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[sleepless-mcp] Server started");
}

main().catch(console.error);
