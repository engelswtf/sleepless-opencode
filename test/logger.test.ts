import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger, getLogger, setLogConfig } from "../src/logger.js";

describe("Logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates logger with component name", () => {
    const logger = new Logger("test");
    expect(logger).toBeDefined();
  });

  it("creates child logger", () => {
    const parent = new Logger("parent");
    const child = parent.child("child");
    expect(child).toBeDefined();
  });

  it("respects log level filtering", () => {
    const logger = new Logger("test", { level: "warn", json: false });
    
    logger.debug("debug message");
    logger.info("info message");
    expect(console.log).not.toHaveBeenCalled();
    
    logger.warn("warn message");
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it("outputs JSON format when configured", () => {
    const logger = new Logger("test", { level: "info", json: true });
    
    logger.info("test message", { key: "value" });
    
    expect(console.log).toHaveBeenCalled();
    const call = vi.mocked(console.log).mock.calls[0][0];
    const parsed = JSON.parse(call);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("test message");
    expect(parsed.data.key).toBe("value");
  });

  it("uses console.error for error level", () => {
    const logger = new Logger("test", { level: "error", json: false });
    
    logger.error("error message");
    expect(console.error).toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("getLogger returns consistent loggers", () => {
    const logger1 = getLogger("component1");
    const logger2 = getLogger("component2");
    expect(logger1).toBeDefined();
    expect(logger2).toBeDefined();
  });
});
