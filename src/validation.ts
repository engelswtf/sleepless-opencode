const MAX_PROMPT_LENGTH = 10000;
const MAX_PROJECT_PATH_LENGTH = 500;

export function validatePrompt(prompt: string): { valid: boolean; error?: string } {
  if (!prompt || typeof prompt !== "string") {
    return { valid: false, error: "Prompt is required" };
  }

  const trimmed = prompt.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: "Prompt cannot be empty" };
  }

  if (trimmed.length > MAX_PROMPT_LENGTH) {
    return { valid: false, error: `Prompt too long (max ${MAX_PROMPT_LENGTH} chars)` };
  }

  return { valid: true };
}

export function validateProjectPath(path: string | undefined): { valid: boolean; error?: string } {
  if (!path) {
    return { valid: true };
  }

  if (typeof path !== "string") {
    return { valid: false, error: "Project path must be a string" };
  }

  if (path.length > MAX_PROJECT_PATH_LENGTH) {
    return { valid: false, error: `Project path too long (max ${MAX_PROJECT_PATH_LENGTH} chars)` };
  }

  const dangerousPatterns = [
    /\.\./,
    /^\/etc/,
    /^\/root(?!\/projects)/,
    /^\/var\/log/,
    /^\/proc/,
    /^\/sys/,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(path)) {
      return { valid: false, error: "Invalid project path" };
    }
  }

  return { valid: true };
}

export function sanitizeForLog(str: string, maxLength = 100): string {
  return str
    .replace(/[\n\r]/g, " ")
    .slice(0, maxLength)
    .trim();
}
