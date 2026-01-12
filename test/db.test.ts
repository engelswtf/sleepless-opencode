import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { TaskQueue, Task } from "../src/db.js";

describe("TaskQueue", () => {
  let db: Database.Database;
  let queue: TaskQueue;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL,
        project_path TEXT,
        status TEXT DEFAULT 'pending',
        priority TEXT DEFAULT 'medium',
        result TEXT,
        error TEXT,
        error_type TEXT,
        session_id TEXT,
        iteration INTEGER DEFAULT 0,
        max_iterations INTEGER DEFAULT 10,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        retry_after TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        created_by TEXT,
        source TEXT NOT NULL,
        depends_on INTEGER,
        progress_tool_calls INTEGER DEFAULT 0,
        progress_last_tool TEXT,
        progress_last_message TEXT,
        progress_updated_at TEXT
      )
    `);
    queue = new TaskQueue(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("create", () => {
    it("creates a task with required fields", () => {
      const task = queue.create({
        prompt: "Test task",
        source: "cli",
      });

      expect(task.id).toBe(1);
      expect(task.prompt).toBe("Test task");
      expect(task.status).toBe("pending");
      expect(task.priority).toBe("medium");
      expect(task.source).toBe("cli");
    });

    it("creates a task with all fields", () => {
      const task = queue.create({
        prompt: "Full task",
        project_path: "/test/path",
        priority: "urgent",
        max_iterations: 5,
        max_retries: 2,
        created_by: "user123",
        source: "discord",
      });

      expect(task.project_path).toBe("/test/path");
      expect(task.priority).toBe("urgent");
      expect(task.max_iterations).toBe(5);
      expect(task.max_retries).toBe(2);
      expect(task.created_by).toBe("user123");
    });
  });

  describe("get", () => {
    it("returns undefined for non-existent task", () => {
      expect(queue.get(999)).toBeUndefined();
    });

    it("returns task by id", () => {
      const created = queue.create({ prompt: "Test", source: "cli" });
      const retrieved = queue.get(created.id);
      expect(retrieved?.prompt).toBe("Test");
    });
  });

  describe("priority ordering", () => {
    it("returns urgent tasks first", () => {
      queue.create({ prompt: "Low", priority: "low", source: "cli" });
      queue.create({ prompt: "Urgent", priority: "urgent", source: "cli" });
      queue.create({ prompt: "High", priority: "high", source: "cli" });

      const next = queue.getNext();
      expect(next?.prompt).toBe("Urgent");
    });

    it("returns older tasks first within same priority", () => {
      const first = queue.create({ prompt: "First", priority: "medium", source: "cli" });
      queue.create({ prompt: "Second", priority: "medium", source: "cli" });

      const next = queue.getNext();
      expect(next?.id).toBe(first.id);
    });
  });

  describe("status transitions", () => {
    it("setRunning updates status and started_at", () => {
      const task = queue.create({ prompt: "Test", source: "cli" });
      queue.setRunning(task.id, "session-123");

      const updated = queue.get(task.id)!;
      expect(updated.status).toBe("running");
      expect(updated.session_id).toBe("session-123");
      expect(updated.started_at).not.toBeNull();
    });

    it("setDone updates status and result", () => {
      const task = queue.create({ prompt: "Test", source: "cli" });
      queue.setRunning(task.id, "session-123");
      queue.setDone(task.id, "Task completed successfully");

      const updated = queue.get(task.id)!;
      expect(updated.status).toBe("done");
      expect(updated.result).toBe("Task completed successfully");
      expect(updated.completed_at).not.toBeNull();
    });

    it("setFailed updates status with error type", () => {
      const task = queue.create({ prompt: "Test", source: "cli" });
      queue.setRunning(task.id, "session-123");
      queue.setFailed(task.id, "Rate limit exceeded", "rate_limit");

      const updated = queue.get(task.id)!;
      expect(updated.status).toBe("failed");
      expect(updated.error).toBe("Rate limit exceeded");
      expect(updated.error_type).toBe("rate_limit");
    });

    it("cancel only affects pending tasks", () => {
      const pending = queue.create({ prompt: "Pending", source: "cli" });
      const running = queue.create({ prompt: "Running", source: "cli" });
      queue.setRunning(running.id, "session-123");

      expect(queue.cancel(pending.id)).toBe(true);
      expect(queue.cancel(running.id)).toBe(false);
      
      expect(queue.get(pending.id)!.status).toBe("cancelled");
      expect(queue.get(running.id)!.status).toBe("running");
    });
  });

  describe("retry logic", () => {
    it("scheduleRetry sets retry_after and increments count", () => {
      const task = queue.create({ prompt: "Test", source: "cli" });
      queue.setRunning(task.id, "session-123");

      const scheduled = queue.scheduleRetry(task.id, 30);
      expect(scheduled).toBe(true);

      const updated = queue.get(task.id)!;
      expect(updated.status).toBe("pending");
      expect(updated.retry_count).toBe(1);
      expect(updated.retry_after).not.toBeNull();
    });

    it("scheduleRetry fails when max retries exceeded", () => {
      const task = queue.create({ prompt: "Test", max_retries: 1, source: "cli" });
      
      queue.scheduleRetry(task.id, 1);
      const secondRetry = queue.scheduleRetry(task.id, 1);
      
      expect(secondRetry).toBe(false);
    });

    it("getNextRetryable respects retry_after", () => {
      const task = queue.create({ prompt: "Test", source: "cli" });
      
      const futureTime = new Date(Date.now() + 60000).toISOString();
      db.prepare("UPDATE tasks SET retry_after = ? WHERE id = ?").run(futureTime, task.id);

      expect(queue.getNextRetryable()).toBeUndefined();
    });
  });

  describe("iteration tracking", () => {
    it("incrementIteration increases counter", () => {
      const task = queue.create({ prompt: "Test", source: "cli" });
      expect(task.iteration).toBe(0);

      const iter1 = queue.incrementIteration(task.id);
      expect(iter1).toBe(1);

      const iter2 = queue.incrementIteration(task.id);
      expect(iter2).toBe(2);
    });
  });

  describe("progress tracking", () => {
    it("updateProgress stores tool calls and messages", () => {
      const task = queue.create({ prompt: "Test", source: "cli" });
      
      queue.updateProgress(task.id, {
        toolCalls: 5,
        lastTool: "bash",
        lastMessage: "Running command...",
      });

      const updated = queue.get(task.id)!;
      expect(updated.progress_tool_calls).toBe(5);
      expect(updated.progress_last_tool).toBe("bash");
      expect(updated.progress_last_message).toBe("Running command...");
    });
  });

  describe("stats", () => {
    it("returns correct counts by status", () => {
      queue.create({ prompt: "Pending 1", source: "cli" });
      queue.create({ prompt: "Pending 2", source: "cli" });
      
      const running = queue.create({ prompt: "Running", source: "cli" });
      queue.setRunning(running.id, "session-123");
      
      const done = queue.create({ prompt: "Done", source: "cli" });
      queue.setDone(done.id, "result");
      
      const failed = queue.create({ prompt: "Failed", source: "cli" });
      queue.setFailed(failed.id, "error");

      const stats = queue.stats();
      expect(stats.pending).toBe(2);
      expect(stats.running).toBe(1);
      expect(stats.done).toBe(1);
      expect(stats.failed).toBe(1);
    });
  });

  describe("task dependencies", () => {
    it("creates task with depends_on", () => {
      const parent = queue.create({ prompt: "Parent task", source: "cli" });
      const child = queue.create({ prompt: "Child task", source: "cli", depends_on: parent.id });

      expect(child.depends_on).toBe(parent.id);
    });

    it("getNextRetryable skips tasks with incomplete dependencies", () => {
      const parent = queue.create({ prompt: "Parent", source: "cli" });
      queue.create({ prompt: "Child", source: "cli", depends_on: parent.id });

      const next = queue.getNextRetryable();
      expect(next?.prompt).toBe("Parent");
    });

    it("getNextRetryable returns dependent task after parent completes", () => {
      const parent = queue.create({ prompt: "Parent", source: "cli" });
      const child = queue.create({ prompt: "Child", source: "cli", depends_on: parent.id });

      queue.setRunning(parent.id, "session-1");
      queue.setDone(parent.id, "done");

      const next = queue.getNextRetryable();
      expect(next?.id).toBe(child.id);
    });

    it("getDependentTasks returns tasks depending on a parent", () => {
      const parent = queue.create({ prompt: "Parent", source: "cli" });
      queue.create({ prompt: "Child 1", source: "cli", depends_on: parent.id });
      queue.create({ prompt: "Child 2", source: "cli", depends_on: parent.id });
      queue.create({ prompt: "Unrelated", source: "cli" });

      const dependents = queue.getDependentTasks(parent.id);
      expect(dependents).toHaveLength(2);
    });

    it("failDependentTasks marks all dependents as failed", () => {
      const parent = queue.create({ prompt: "Parent", source: "cli" });
      const child1 = queue.create({ prompt: "Child 1", source: "cli", depends_on: parent.id });
      const child2 = queue.create({ prompt: "Child 2", source: "cli", depends_on: parent.id });

      queue.failDependentTasks(parent.id, "Parent failed");

      expect(queue.get(child1.id)!.status).toBe("failed");
      expect(queue.get(child2.id)!.status).toBe("failed");
      expect(queue.get(child1.id)!.error_type).toBe("dependency_failed");
    });
  });
});
