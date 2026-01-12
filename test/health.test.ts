import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HealthServer } from "../src/health.js";

describe("HealthServer", () => {
  it("creates health server instance", () => {
    const mockQueue = {
      stats: () => ({ pending: 1, running: 0, done: 5, failed: 1 }),
    } as any;
    
    const mockDaemon = {
      getCurrentTask: () => null,
      isShuttingDown: () => false,
      getMode: () => "sdk" as const,
    } as any;

    const server = new HealthServer(mockQueue, mockDaemon, "1.0.0");
    expect(server).toBeDefined();
  });
});
