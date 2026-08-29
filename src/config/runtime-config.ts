const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "low" | "high" | "max";

export interface ProviderCredentials {
  readonly apiKey: string;
}

export interface ProviderSettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly thinking: ThinkingMode;
  readonly reasoningEffort: ReasoningEffort;
  readonly requestTimeoutMs: number;
  readonly maxOutputTokens: number;
}

export interface RuntimeConfig {
  readonly credentials: ProviderCredentials;
  readonly provider: ProviderSettings;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const apiKey = firstNonBlank(
    environment.DEEPSEEK_API_KEY,
    environment.NASH_API_KEY,
  );
  if (apiKey === undefined) {
    throw new ConfigurationError(
      "DEEPSEEK_API_KEY is required; keep it in an untracked environment file",
    );
  }

  const baseUrl = normalizeBaseUrl(
    firstNonBlank(environment.NASH_BASE_URL) ?? DEFAULT_BASE_URL,
  );
  const model = firstNonBlank(environment.NASH_MODEL) ?? DEFAULT_MODEL;
  const thinking = parseChoice(
    "NASH_THINKING",
    environment.NASH_THINKING,
    ["enabled", "disabled"] as const,
    "enabled",
  );
  const reasoningEffort = parseChoice(
    "NASH_REASONING_EFFORT",
    environment.NASH_REASONING_EFFORT,
    ["low", "high", "max"] as const,
    "high",
  );

  return {
    credentials: { apiKey },
    provider: {
      baseUrl,
      model,
      thinking,
      reasoningEffort,
      requestTimeoutMs: parseInteger(
        "NASH_REQUEST_TIMEOUT_SECONDS",
        environment.NASH_REQUEST_TIMEOUT_SECONDS,
        180,
        1,
        600,
      ) * 1_000,
      maxOutputTokens: parseInteger(
        "NASH_MAX_OUTPUT_TOKENS",
        environment.NASH_MAX_OUTPUT_TOKENS,
        16_384,
        256,
        384_000,
      ),
    },
  };
}

function firstNonBlank(...values: readonly (string | undefined)[]):
  | string
  | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("NASH_BASE_URL must be a valid URL");
  }

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ConfigurationError(
      "NASH_BASE_URL must use HTTPS unless it points to localhost",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(
      "NASH_BASE_URL cannot contain credentials, query parameters, or fragments",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function parseChoice<const T extends readonly string[]>(
  name: string,
  value: string | undefined,
  choices: T,
  fallback: T[number],
): T[number] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    return fallback;
  }
  if (!choices.includes(normalized)) {
    throw new ConfigurationError(`${name} must be one of ${choices.join(", ")}`);
  }
  return normalized;
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new ConfigurationError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
