import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  load: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: storeMocks.load,
  },
}));

import {
  AUTO_EXECUTE_MUTATING_TOOLS_KEY,
  DEFAULT_EXECUTION_POLICY,
  canAutoExecuteTool,
  loadExecutionPolicy,
} from "@/services/executionPolicy";

describe("executionPolicy", () => {
  beforeEach(() => {
    storeMocks.load.mockReset();
    storeMocks.get.mockReset();
    storeMocks.load.mockResolvedValue({ get: storeMocks.get });
  });

  it("defaults to interactive approval when the persisted value is missing", async () => {
    storeMocks.get.mockResolvedValue(undefined);

    await expect(loadExecutionPolicy()).resolves.toEqual(DEFAULT_EXECUTION_POLICY);
    expect(storeMocks.get).toHaveBeenCalledWith(AUTO_EXECUTE_MUTATING_TOOLS_KEY);
  });

  it("only accepts the literal boolean true and fails closed on store errors", async () => {
    storeMocks.get.mockResolvedValue("true");
    await expect(loadExecutionPolicy()).resolves.toEqual(DEFAULT_EXECUTION_POLICY);

    storeMocks.get.mockResolvedValue(true);
    await expect(loadExecutionPolicy()).resolves.toEqual({ autoExecuteMutatingTools: true });

    storeMocks.load.mockRejectedValue(new Error("store unavailable"));
    await expect(loadExecutionPolicy()).resolves.toEqual(DEFAULT_EXECUTION_POLICY);
  });

  it("auto-executes only approval-gated mutating tools in act mode", () => {
    const enabled = { autoExecuteMutatingTools: true };

    expect(canAutoExecuteTool(enabled, {
      mode: "act",
      mutating: true,
      requiresApproval: true,
    })).toBe(true);

    expect(canAutoExecuteTool(enabled, {
      mode: "observe",
      mutating: true,
      requiresApproval: true,
    })).toBe(false);
    expect(canAutoExecuteTool(enabled, {
      mode: "unrestricted",
      mutating: true,
      requiresApproval: true,
    })).toBe(false);
    expect(canAutoExecuteTool(enabled, {
      mode: "act",
      mutating: false,
      requiresApproval: true,
    })).toBe(false);
    expect(canAutoExecuteTool(enabled, {
      mode: "act",
      mutating: true,
      requiresApproval: false,
    })).toBe(false);
    expect(canAutoExecuteTool(DEFAULT_EXECUTION_POLICY, {
      mode: "act",
      mutating: true,
      requiresApproval: true,
    })).toBe(false);
  });
});
