#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { initDb, TaskQueue } from "./db.js";

const program = new Command();

program
  .name("sleepless")
  .description("CLI for sleepless-opencode task queue")
  .version("0.1.0");

program
  .command("add")
  .description("Add a task to the queue")
  .argument("<prompt>", "Task prompt")
  .option("-p, --priority <level>", "Priority: high, medium, low", "medium")
  .option("--project <path>", "Project path")
  .action((prompt, options) => {
    const db = initDb();
    const queue = new TaskQueue(db);

    const task = queue.create({
      prompt,
      priority: options.priority,
      project_path: options.project,
      source: "cli",
    });

    console.log(`Task #${task.id} added (${task.priority} priority)`);
    db.close();
  });

program
  .command("list")
  .description("List tasks")
  .option("-s, --status <status>", "Filter by status")
  .option("-n, --limit <n>", "Number of tasks", "10")
  .action((options) => {
    const db = initDb();
    const queue = new TaskQueue(db);

    const tasks = queue.list(options.status, parseInt(options.limit, 10));

    if (tasks.length === 0) {
      console.log("No tasks found.");
    } else {
      const statusEmoji: Record<string, string> = {
        pending: "⏳",
        running: "🔄",
        done: "✅",
        failed: "❌",
        cancelled: "🚫",
      };

      tasks.forEach((t) => {
        console.log(`${statusEmoji[t.status]} #${t.id} [${t.priority}] ${t.prompt.slice(0, 60)}...`);
      });
    }

    db.close();
  });

program
  .command("status")
  .description("Show queue status")
  .action(() => {
    const db = initDb();
    const queue = new TaskQueue(db);

    const stats = queue.stats();
    const running = queue.getRunning();

    console.log("Queue Status:");
    console.log(`  Pending: ${stats.pending}`);
    console.log(`  Running: ${stats.running}`);
    console.log(`  Done:    ${stats.done}`);
    console.log(`  Failed:  ${stats.failed}`);

    if (running) {
      console.log(`\nCurrently running: #${running.id} - ${running.prompt.slice(0, 50)}...`);
    }

    db.close();
  });

program
  .command("cancel")
  .description("Cancel a pending task")
  .argument("<id>", "Task ID")
  .action((id) => {
    const db = initDb();
    const queue = new TaskQueue(db);

    const success = queue.cancel(parseInt(id, 10));
    if (success) {
      console.log(`Task #${id} cancelled.`);
    } else {
      console.log(`Could not cancel task #${id}. It may not be pending.`);
    }

    db.close();
  });

program
  .command("get")
  .description("Get task details")
  .argument("<id>", "Task ID")
  .action((id) => {
    const db = initDb();
    const queue = new TaskQueue(db);

    const task = queue.get(parseInt(id, 10));
    if (task) {
      console.log(JSON.stringify(task, null, 2));
    } else {
      console.log(`Task #${id} not found.`);
    }

    db.close();
  });

program.parse();
