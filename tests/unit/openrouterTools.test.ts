import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api/luczorApi", () => ({
  getApiConfig: vi.fn().mockResolvedValue({
    baseUrl: "https://luczor.example",
    deviceKey: "device-key",
    clientId: "client-1",
  }),
}));

import { OpenRouterService } from "@/services/openrouter.service";

describe("OpenRouterService tool choice", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends required for an explicit execution round", async () => {
    await OpenRouterService.streamChatWithTools({
      messages: [{ role: "user", content: "Speichere das Ziel" }],
      tools: [{ type: "function", function: { name: "project_upsert_goal" } }],
      toolChoice: "required",
    });

    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.tool_choice).toBe("required");
    expect(body.tools[0].function.name).toBe("project_upsert_goal");
  });
});
