// System One (Jev) mirrors the chat no-auth proxy rotation: a rate-limited
// pool is excluded so the retry rotates to another one, and a success clears
// the pool cooldown for the provider.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  enforceKeyAccessResolved: vi.fn(() => null),
  handleSystemoneCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  errorResponse: vi.fn((status, message) => new Response(JSON.stringify({ error: { message } }), { status })),
  unavailableResponse: vi.fn((status, message) => new Response(JSON.stringify({ error: { message } }), { status })),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({ getModelInfo: mocks.getModelInfo }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  enforceKeyAccessResolved: mocks.enforceKeyAccessResolved,
}));
vi.mock("open-sse/handlers/systemoneCore.js", () => ({ handleSystemoneCore: mocks.handleSystemoneCore }));
vi.mock("open-sse/utils/error.js", () => ({
  errorResponse: mocks.errorResponse,
  unavailableResponse: mocks.unavailableResponse,
}));
vi.mock("open-sse/config/runtimeConfig.js", async (importOriginal) => ({
  ...(await importOriginal()),
  HTTP_STATUS: { BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, SERVICE_UNAVAILABLE: 503 },
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  request: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));

const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");

const CRED_A = {
  connectionId: "noauth",
  connectionName: "Public",
  providerSpecificData: { connectionProxyPoolId: "pool-a" },
};
const CRED_B = {
  connectionId: "noauth",
  connectionName: "Public",
  providerSpecificData: { connectionProxyPoolId: "pool-b" },
};

function makeRequest() {
  return new Request("http://router.test/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "opencode/jev-1.13-free",
      state: { a: 1 },
      questions: { q: "is it on?" },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false });
  mocks.getModelInfo.mockResolvedValue({ provider: "opencode", model: "jev-1.13-free" });
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 2000 });
});

describe("systemone no-auth proxy fallback", () => {
  it("excludes the failed pool and retries with a different pool", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce(CRED_A).mockResolvedValueOnce(CRED_B);
    mocks.handleSystemoneCore
      .mockResolvedValueOnce({ success: false, status: 429, error: "Too Many Requests" })
      .mockImplementationOnce(async ({ onRequestSuccess }) => {
        await onRequestSuccess?.();
        return { success: true, response: new Response("ok", { status: 200 }) };
      });

    const response = await handleSystemone(makeRequest());

    expect(response.status).toBe(200);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "noauth",
      429,
      "Too Many Requests",
      "opencode",
      "jev-1.13-free",
      null,
      "pool-a",
    );
    expect(mocks.getProviderCredentials.mock.calls[1][3].excludeProxyPoolIds).toEqual(
      new Set(["pool-a"]),
    );
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "noauth",
      expect.objectContaining({ providerSpecificData: { connectionProxyPoolId: "pool-b" } }),
      "jev-1.13-free",
      "opencode",
    );
  });

  it("returns unavailable after every pool fails without retrying a pool", async () => {
    const exclusionSnapshots = [];
    const credentialResponses = [
      CRED_A,
      CRED_B,
      {
        allRateLimited: true,
        retryAfter: "2026-08-13T00:00:10.000Z",
        retryAfterHuman: "reset after 10s",
        lastError: "429 from pool-b",
        lastErrorCode: 429,
      },
    ];
    mocks.getProviderCredentials.mockImplementation(async (_provider, _exclude, _model, options) => {
      exclusionSnapshots.push(new Set(options?.excludeProxyPoolIds ?? []));
      return credentialResponses.shift();
    });
    mocks.handleSystemoneCore
      .mockResolvedValueOnce({ success: false, status: 429, error: "429 from pool-a" })
      .mockResolvedValueOnce({ success: false, status: 429, error: "429 from pool-b" });

    const response = await handleSystemone(makeRequest());

    expect(response.status).toBe(429);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledTimes(2);
    expect(exclusionSnapshots).toEqual([
      new Set(),
      new Set(["pool-a"]),
      new Set(["pool-a", "pool-b"]),
    ]);
  });
});
