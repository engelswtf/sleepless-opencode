import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Task {
  id: number;
  prompt: string;
  project_path: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  result: string | null;
  error: string | null;
  error_type: string | null;
  session_id: string | null;
  iteration: number;
  max_iterations: number;
  retry_count: number;
  max_retries: number;
  retry_after: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  source: "discord" | "slack" | "cli";
  depends_on: number | null;
  progress_tool_calls: number;
  progress_last_tool: string | null;
  progress_last_message: string | null;
  progress_updated_at: string | null;
}

export interface TaskCreate {
  prompt: string;
  project_path?: string;
  priority?: TaskPriority;
  max_iterations?: number;
  max_retries?: number;
  created_by?: string;
  source: "discord" | "slack" | "cli";
  depends_on?: number;
}

const DATA_DIR = process.env.SLEEPLESS_DATA_DIR || join(process.cwd(), "data");

export function initDb(): Database.Database {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(join(DATA_DIR, "sleepless.db"));
  
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt TEXT NOT NULL,
      project_path TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      result TEXT,
      error TEXT,
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
      source TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_retry_after ON tasks(retry_after);
  `);

  const migrations = [
    `ALTER TABLE tasks ADD COLUMN iteration INTEGER DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN max_iterations INTEGER DEFAULT 10`,
    `ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN max_retries INTEGER DEFAULT 3`,
    `ALTER TABLE tasks ADD COLUMN retry_after TEXT`,
    `ALTER TABLE tasks ADD COLUMN error_type TEXT`,
    `ALTER TABLE tasks ADD COLUMN progress_tool_calls INTEGER DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN progress_last_tool TEXT`,
    `ALTER TABLE tasks ADD COLUMN progress_last_message TEXT`,
    `ALTER TABLE tasks ADD COLUMN progress_updated_at TEXT`,
    `ALTER TABLE tasks ADD COLUMN depends_on INTEGER`,
  ];
  
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column exists */ }
  }

  return db;
}

export class TaskQueue {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(task: TaskCreate): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (prompt, project_path, priority, max_iterations, max_retries, created_by, source, depends_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      task.prompt,
      task.project_path || null,
      task.priority || "medium",
      task.max_iterations || 10,
      task.max_retries || 3,
      task.created_by || null,
      task.source,
      task.depends_on || null
    );

    return this.get(result.lastInsertRowid as number)!;
  }

  get(id: number): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  }

  getNext(): Task | undefined {
    return this.db.prepare(`
      SELECT * FROM tasks 
      WHERE status = 'pending'
      ORDER BY 
        CASE priority 
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1 
          WHEN 'medium' THEN 2 
          WHEN 'low' THEN 3 
        END,
        created_at ASC
      LIMIT 1
    `).get() as Task | undefined;
  }

  getRunning(): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE status = 'running' LIMIT 1").get() as Task | undefined;
  }

  setRunning(id: number, sessionId: string): void {
    this.db.prepare(`
      UPDATE tasks 
      SET status = 'running', started_at = datetime('now'), session_id = ?
      WHERE id = ?
    `).run(sessionId, id);
  }

  incrementIteration(id: number): number {
    this.db.prepare(`UPDATE tasks SET iteration = iteration + 1 WHERE id = ?`).run(id);
    const task = this.get(id);
    return task?.iteration || 0;
  }

  updateSessionId(id: number, sessionId: string): void {
    this.db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(sessionId, id);
  }

  updateProgress(id: number, progress: { toolCalls: number; lastTool?: string; lastMessage?: string }): void {
    this.db.prepare(`
      UPDATE tasks 
      SET progress_tool_calls = ?,
          progress_last_tool = ?,
          progress_last_message = ?,
          progress_updated_at = datetime('now')
      WHERE id = ?
    `).run(
      progress.toolCalls,
      progress.lastTool || null,
      progress.lastMessage ? progress.lastMessage.slice(0, 1000) : null,
      id
    );
  }

  setDone(id: number, result: string): void {
    this.db.prepare(`
      UPDATE tasks 
      SET status = 'done', result = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(result, id);
  }

  setFailed(id: number, error: string, errorType?: string): void {
    this.db.prepare(`
      UPDATE tasks 
      SET status = 'failed', error = ?, error_type = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(error, errorType || null, id);
  }

  cancel(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status = 'pending'
    `).run(id);
    return result.changes > 0;
  }

  resetToPending(id: number): void {
    this.db.prepare(`
      UPDATE tasks SET status = 'pending', started_at = NULL, session_id = NULL, iteration = 0 WHERE id = ?
    `).run(id);
  }

  scheduleRetry(id: number, delaySeconds: number): boolean {
    const task = this.get(id);
    if (!task || task.retry_count >= task.max_retries) {
      return false;
    }
    
    const retryAfter = new Date(Date.now() + delaySeconds * 1000).toISOString();
    this.db.prepare(`
      UPDATE tasks 
      SET status = 'pending', 
          retry_count = retry_count + 1,
          retry_after = ?,
          iteration = 0,
          session_id = NULL,
          started_at = NULL,
          error = NULL
      WHERE id = ?
    `).run(retryAfter, id);
    return true;
  }

  getNextRetryable(): Task | undefined {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT t.* FROM tasks t
      LEFT JOIN tasks dep ON t.depends_on = dep.id
      WHERE t.status = 'pending'
        AND (t.retry_after IS NULL OR t.retry_after <= ?)
        AND (t.depends_on IS NULL OR dep.status = 'done')
      ORDER BY 
        CASE t.priority 
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1 
          WHEN 'medium' THEN 2 
          WHEN 'low' THEN 3 
        END,
        t.created_at ASC
      LIMIT 1
    `).get(now) as Task | undefined;
  }

  getDependentTasks(taskId: number): Task[] {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE depends_on = ? AND status = 'pending'
    `).all(taskId) as Task[];
  }

  failDependentTasks(taskId: number, reason: string): void {
    this.db.prepare(`
      UPDATE tasks 
      SET status = 'failed', 
          error = ?,
          error_type = 'dependency_failed',
          completed_at = datetime('now')
      WHERE depends_on = ? AND status = 'pending'
    `).run(reason, taskId);
  }

  list(status?: TaskStatus, limit = 10): Task[] {
    if (status) {
      return this.db.prepare(`
        SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?
      `).all(status, limit) as Task[];
    }
    return this.db.prepare(`
      SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Task[];
  }

  stats(): { pending: number; running: number; done: number; failed: number } {
    const result = this.db.prepare(`
      SELECT 
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks
    `).get() as any;

    return {
      pending: result.pending || 0,
      running: result.running || 0,
      done: result.done || 0,
      failed: result.failed || 0,
    };
  }
}
