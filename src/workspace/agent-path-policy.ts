const RESERVED_SEGMENTS = new Set([".git", ".nash"]);
const PROTECTED_FILES = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
]);
const SHAREABLE_ENV_FILES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

export class AgentPathPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AgentPathPolicyError";
  }
}

export function assertAgentPathAllowed(input: string): void {
  for (const segment of pathSegments(input)) {
    const normalized = segment.toLowerCase();
    if (RESERVED_SEGMENTS.has(normalized)) {
      throw new AgentPathPolicyError(
        `path segment ${JSON.stringify(segment)} is reserved from agent tools`,
      );
    }
    if (isProtectedFileName(normalized)) {
      throw new AgentPathPolicyError(
        `credential-bearing file ${JSON.stringify(segment)} is not available to agent tools`,
      );
    }
  }
}

export function isAgentVisibleName(name: string): boolean {
  try {
    assertAgentPathAllowed(name);
    return true;
  } catch (error) {
    if (error instanceof AgentPathPolicyError) {
      return false;
    }
    throw error;
  }
}

function pathSegments(input: string): readonly string[] {
  return input.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
}

function isProtectedFileName(normalized: string): boolean {
  if (PROTECTED_FILES.has(normalized)) {
    return true;
  }
  return (
    (normalized === ".env" || normalized.startsWith(".env.")) &&
    !SHAREABLE_ENV_FILES.has(normalized)
  );
}
