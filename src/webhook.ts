import { Task } from "./db.js";

export interface WebhookConfig {
  url: string;
  secret?: string;
  events?: ("started" | "completed" | "failed")[];
}

export interface WebhookPayload {
  event: "started" | "completed" | "failed";
  timestamp: string;
  task: {
    id: number;
    prompt: string;
    status: string;
    priority: string;
    project_path: string | null;
    source: string;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    iteration: number;
    retry_count: number;
  };
  result?: string;
  error?: string;
}

export class WebhookNotifier {
  private config: WebhookConfig;

  constructor(config: WebhookConfig) {
    this.config = config;
  }

  async notify(event: "started" | "completed" | "failed", task: Task, result?: string, error?: string): Promise<void> {
    if (this.config.events && !this.config.events.includes(event)) {
      return;
    }

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      task: {
        id: task.id,
        prompt: task.prompt.slice(0, 500),
        status: task.status,
        priority: task.priority,
        project_path: task.project_path,
        source: task.source,
        created_at: task.created_at,
        started_at: task.started_at,
        completed_at: task.completed_at,
        iteration: task.iteration,
        retry_count: task.retry_count,
      },
    };

    if (result) payload.result = result.slice(0, 2000);
    if (error) payload.error = error.slice(0, 1000);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "sleepless-opencode/1.0",
    };

    if (this.config.secret) {
      const signature = await this.sign(JSON.stringify(payload), this.config.secret);
      headers["X-Sleepless-Signature"] = signature;
    }

    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        console.error(`[webhook] HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      console.error(`[webhook] Failed to send notification:`, err);
    }
  }

  private async sign(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return `sha256=${Buffer.from(signature).toString("hex")}`;
  }
}
