import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { TaskQueue } from "./db.js";
import { Daemon } from "./daemon.js";
import { getLogger } from "./logger.js";

const log = getLogger("health");

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  version: string;
  mode: "sdk" | "cli";
  queue: {
    pending: number;
    running: number;
    done: number;
    failed: number;
  };
  currentTask: {
    id: number;
    prompt: string;
    startedAt: string;
    elapsedSeconds: number;
  } | null;
  shuttingDown: boolean;
}

export class HealthServer {
  private server: Server | null = null;
  private startTime = Date.now();
  private queue: TaskQueue;
  private daemon: Daemon;
  private version: string;

  constructor(queue: TaskQueue, daemon: Daemon, version: string) {
    this.queue = queue;
    this.daemon = daemon;
    this.version = version;
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          log.warn("Port in use, health server disabled", { port });
          resolve();
        } else {
          reject(err);
        }
      });

      this.server.listen(port, () => {
        log.info("Health server listening", { url: `http://localhost:${port}` });
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private getMode(): "sdk" | "cli" {
    return this.daemon.getMode();
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || "/";

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    switch (url) {
      case "/health":
      case "/healthz":
        this.handleHealth(res);
        break;
      case "/ready":
      case "/readyz":
        this.handleReady(res);
        break;
      case "/status":
        this.handleStatus(res);
        break;
      case "/metrics":
        this.handleMetrics(res);
        break;
      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  private handleHealth(res: ServerResponse): void {
    const status = this.getHealthStatus();
    const httpStatus = status.status === "healthy" ? 200 : status.status === "degraded" ? 200 : 503;
    res.writeHead(httpStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  }

  private handleReady(res: ServerResponse): void {
    const isReady = !this.daemon.isShuttingDown();
    res.writeHead(isReady ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ready: isReady }));
  }

  private handleStatus(res: ServerResponse): void {
    const status = this.getHealthStatus();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status, null, 2));
  }

  private handleMetrics(res: ServerResponse): void {
    const stats = this.queue.stats();
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    
    const metrics = [
      `# HELP sleepless_uptime_seconds Daemon uptime in seconds`,
      `# TYPE sleepless_uptime_seconds gauge`,
      `sleepless_uptime_seconds ${uptime}`,
      ``,
      `# HELP sleepless_tasks_total Total tasks by status`,
      `# TYPE sleepless_tasks_total gauge`,
      `sleepless_tasks_total{status="pending"} ${stats.pending}`,
      `sleepless_tasks_total{status="running"} ${stats.running}`,
      `sleepless_tasks_total{status="done"} ${stats.done}`,
      `sleepless_tasks_total{status="failed"} ${stats.failed}`,
      ``,
      `# HELP sleepless_mode Current execution mode (1=sdk, 0=cli)`,
      `# TYPE sleepless_mode gauge`,
      `sleepless_mode{mode="sdk"} ${this.getMode() === "sdk" ? 1 : 0}`,
      `sleepless_mode{mode="cli"} ${this.getMode() === "cli" ? 1 : 0}`,
    ].join("\n");

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(metrics);
  }

  private getHealthStatus(): HealthStatus {
    const stats = this.queue.stats();
    const currentTask = this.daemon.getCurrentTask();
    const shuttingDown = this.daemon.isShuttingDown();

    let status: "healthy" | "degraded" | "unhealthy" = "healthy";
    if (shuttingDown) {
      status = "degraded";
    }
    if (this.getMode() === "cli") {
      status = "degraded";
    }

    let currentTaskInfo: HealthStatus["currentTask"] = null;
    if (currentTask) {
      const startedAt = currentTask.started_at ? new Date(currentTask.started_at) : new Date();
      currentTaskInfo = {
        id: currentTask.id,
        prompt: currentTask.prompt.slice(0, 100) + (currentTask.prompt.length > 100 ? "..." : ""),
        startedAt: startedAt.toISOString(),
        elapsedSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      };
    }

    return {
      status,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: this.version,
      mode: this.getMode(),
      queue: stats,
      currentTask: currentTaskInfo,
      shuttingDown,
    };
  }
}
