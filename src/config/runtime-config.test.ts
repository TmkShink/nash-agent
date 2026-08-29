import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  loadRuntimeConfig,
} from "./runtime-config.js";

test("loadRuntimeConfig uses DeepSeek defaults without exposing the key", () => {
  const config = loadRuntimeConfig({ DEEPSEEK_API_KEY: " test-secret " });

  assert.equal(config.credentials.apiKey, "test-secret");
  assert.deepEqual(config.provider, {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    thinking: "enabled",
    reasoningEffort: "high",
    requestTimeoutMs: 180_000,
    maxOutputTokens: 16_384,
  });
  assert.doesNotMatch(JSON.stringify(config.provider), /test-secret/);
});

test("loadRuntimeConfig rejects missing credentials", () => {
  assert.throws(() => loadRuntimeConfig({}), ConfigurationError);
});

test("loadRuntimeConfig accepts a local HTTP mock endpoint", () => {
  const config = loadRuntimeConfig({
    DEEPSEEK_API_KEY: "test-secret",
    NASH_BASE_URL: "http://127.0.0.1:8080/",
  });

  assert.equal(config.provider.baseUrl, "http://127.0.0.1:8080");
});

test("loadRuntimeConfig rejects insecure remote endpoints", () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        DEEPSEEK_API_KEY: "test-secret",
        NASH_BASE_URL: "http://example.com",
      }),
    /must use HTTPS/,
  );
});

test("loadRuntimeConfig validates bounded enum and integer settings", () => {
  const invalidEnvironments = [
    { DEEPSEEK_API_KEY: "key", NASH_THINKING: "sometimes" },
    { DEEPSEEK_API_KEY: "key", NASH_REASONING_EFFORT: "extreme" },
    { DEEPSEEK_API_KEY: "key", NASH_REQUEST_TIMEOUT_SECONDS: "0" },
    { DEEPSEEK_API_KEY: "key", NASH_MAX_OUTPUT_TOKENS: "many" },
  ];

  for (const environment of invalidEnvironments) {
    assert.throws(() => loadRuntimeConfig(environment), ConfigurationError);
  }
});
