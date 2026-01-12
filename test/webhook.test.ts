import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebhookNotifier, WebhookPayload } from "../src/webhook.js";
import { Task } from "../src/db.js";

describe("WebhookNotifier", () => {
  const mockTask: Task = {
    id: 1,
    prompt: "Test task",
    project_path: "/test",
    status: "done",
    priority: "medium",
    result: "Success",
    error: null,
    error_type: null,
    session_id: "session-123",
    iteration: 1,
    max_iterations: 10,
    retry_count: 0,
    max_retries: 3,
    retry_after: null,
    created_at: "2024-01-01T00:00:00.000Z",
    started_at: "2024-01-01T00:00:01.000Z",
    completed_at: "2024-01-01T00:00:10.000Z",
    created_by: "test",
    source: "cli",
    depends_on: null,
    progress_tool_calls: 5,
    progress_last_tool: "bash",
    progress_last_message: "Done",
    progress_updated_at: "2024-01-01T00:00:09.000Z",
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates notifier with config", () => {
    const notifier = new WebhookNotifier({
      url: "https://example.com/webhook",
    });
    expect(notifier).toBeDefined();
  });

  it("filters events based on config", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("OK"));
    
    const notifier = new WebhookNotifier({
      url: "https://example.com/webhook",
      events: ["completed"],
    });

    await notifier.notify("started", mockTask);
    expect(fetchSpy).not.toHaveBeenCalled();

    await notifier.notify("completed", mockTask, "Success");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends correct payload structure", async () => {
    let capturedBody: WebhookPayload | null = null;
    
    vi.spyOn(global, "fetch").mockImplementation(async (url, options) => {
      capturedBody = JSON.parse(options?.body as string);
      return new Response("OK");
    });

    const notifier = new WebhookNotifier({
      url: "https://example.com/webhook",
    });

    await notifier.notify("completed", mockTask, "Task done");

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.event).toBe("completed");
    expect(capturedBody!.task.id).toBe(1);
    expect(capturedBody!.task.prompt).toBe("Test task");
    expect(capturedBody!.result).toBe("Task done");
  });

  it("handles fetch errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("Network error"));

    const notifier = new WebhookNotifier({
      url: "https://example.com/webhook",
    });

    await expect(notifier.notify("completed", mockTask)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
  });
});
