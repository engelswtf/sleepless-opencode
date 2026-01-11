import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: number;
  prompt: string;
  project_path: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  result: string | null;
  error: string | null;
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_by: string | null; // discord user id or slack user id
  source: "discord" | "slack" | "cli";
}

export interface TaskCreate {
  prompt: string;
  project_path?: string;
  priority?: TaskPriority;
  created_by?: string;
  source: "discord" | "slack" | "cli";
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
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      created_by TEXT,
      source TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
  `);

  return db;
}

export class TaskQueue {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(task: TaskCreate): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (prompt, project_path, priority, created_by, source)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      task.prompt,
      task.project_path || null,
      task.priority || "medium",
      task.created_by || null,
      task.source
    );

    return this.get(result.lastInsertRowid as number)!;
  }

  get(id: number): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  }

  getNext(): Task | undefined {
    // Get highest priority pending task (high > medium > low)
    return this.db.prepare(`
      SELECT * FROM tasks 
      WHERE status = 'pending'
      ORDER BY 
        CASE priority 
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

  setDone(id: number, result: string): void {
    this.db.prepare(`
      UPDATE tasks 
      SET status = 'done', result = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(result, id);
  }

  setFailed(id: number, error: string): void {
    this.db.prepare(`
      UPDATE tasks 
      SET status = 'failed', error = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(error, id);
  }

  cancel(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status = 'pending'
    `).run(id);
    return result.changes > 0;
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
