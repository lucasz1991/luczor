// src/services/openrouter.service.ts
import { Store } from "@tauri-apps/plugin-store";
import { getApiConfig } from "@/services/api/luczorApi";

export type LuczorMode = "observe" | "act" | "unrestricted";

/* =========================================================
 * Wire message shapes (OpenAI/OpenRouter chat format)
 * ========================================================= */
export type WireToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON string of arguments (always complete here — non-streaming). */
    arguments: string;
  };
};

export type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: WireToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/* =========================================================
 * Parsed result of a single completion round
 * ========================================================= */
export type ParsedToolCall = {
  id: string;
  name: string;
  /** Parsed arguments object; {} if the model produced invalid JSON. */
  arguments: Record<string, unknown>;
  /** Original argument string as returned by the model. */
  rawArguments: string;
};

export type ChatResult = {
  /** Assistant free-text content (may be "" when the model only calls tools). */
  content: string;
  /** Parsed tool calls (empty when the model returned a final answer). */
  toolCalls: ParsedToolCall[];
  /** Raw tool calls, to be echoed back into the assistant wire message. */
  rawToolCalls: WireToolCall[];
  finishReason: string;
};

type ChatWithToolsArgs = {
  model: string;
  messages: WireMessage[];
  tools?: unknown[];
  projectId?: string;
  taskType?: string;
  contextId?: string;
  repoId?: string;
  branch?: string;
  commitSha?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

type StreamChatArgs = ChatWithToolsArgs & {
  /** Called with the full accumulated content each time a token arrives. */
  onToken?: (content: string) => void;
};

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

function safeParseArgs(raw: string): Record<string, unknown> {
  const s = (raw ?? "").trim();
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function getApiKey(): Promise<string> {
  const store = await Store.load("luczor.settings.json");
  const key = (await store.get<string>("openrouter_api_key")) ?? "";
  return key.trim();
}

/**
 * Resolve the chat endpoint + headers. When the server proxy is enabled the
 * request is sent to the Laravel proxy (authenticated with the device key) and
 * the server injects the real OpenRouter key — so no provider key on the client.
 */
async function getEndpoint(): Promise<{ url: string; headers: Record<string, string>; proxied: boolean; clientId?: string }> {
  const store = await Store.load("luczor.settings.json");
  // Server proxy is the default: no OpenRouter key on the client.
  const useProxy = (await store.get<boolean>("use_server_proxy")) ?? true;

  if (useProxy) {
    const cfg = await getApiConfig(); // baseUrl defaults to the production domain
    if (!cfg.deviceKey) {
      throw new Error("Server-Proxy aktiv, aber Device-Key fehlt (Settings → Server).");
    }
    return {
      url: `${cfg.baseUrl}/api/v1/proxy/chat`,
      headers: { Authorization: `Bearer ${cfg.deviceKey}`, "Content-Type": "application/json" },
      proxied: true,
      clientId: cfg.clientId,
    };
  }

  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("Kein OpenRouter API Key gesetzt (Settings).");
  return {
    url: OR_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://luczor.local",
      "X-Title": "Luczor",
    },
    proxied: false,
  };
}

function attachLuczorMeta(body: Record<string, unknown>, endpoint: Awaited<ReturnType<typeof getEndpoint>>, args: ChatWithToolsArgs) {
  if (!endpoint.proxied) return;
  body.client_id = endpoint.clientId;
  body.project_id = args.projectId;
  body.task_type = args.taskType ?? "chat.general";
  body.context_id = args.contextId;
  body.context_strategy_id = "context.memory_code_budgeted";
  body.network_policy_id = "proxy.openrouter.default";
  body.repo_id = args.repoId;
  body.branch = args.branch;
  body.commit_sha = args.commitSha;
}

export class OpenRouterService {
  /**
   * Single non-streaming chat completion with tool-calling enabled.
   *
   * Returns the assistant's text and/or the tool calls it wants to make.
   * The caller (agent loop) executes tools, appends results, and calls again.
   */
  static async chatWithTools(args: ChatWithToolsArgs): Promise<ChatResult> {
    const endpoint = await getEndpoint();

    const body: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      temperature: args.temperature ?? 0.2,
    };
    if (args.tools && args.tools.length) {
      body.tools = args.tools;
      body.tool_choice = "auto";
    }
    if (typeof args.maxTokens === "number") {
      body.max_tokens = args.maxTokens;
    }
    attachLuczorMeta(body, endpoint, args);

    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify(body),
      signal: args.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`OpenRouter HTTP ${res.status}: ${txt || res.statusText}`);
    }

    const json: any = await res.json();
    const choice = json?.choices?.[0];
    const message = choice?.message ?? {};

    const content = typeof message.content === "string" ? message.content : "";
    const finishReason = String(choice?.finish_reason ?? "stop");

    const rawToolCalls: WireToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .filter((tc: any) => tc?.function?.name)
          .map((tc: any) => ({
            id: String(tc.id ?? `call_${Math.random().toString(16).slice(2)}`),
            type: "function" as const,
            function: {
              name: String(tc.function.name),
              arguments:
                typeof tc.function.arguments === "string" ? tc.function.arguments : "{}",
            },
          }))
      : [];

    const toolCalls: ParsedToolCall[] = rawToolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseArgs(tc.function.arguments),
      rawArguments: tc.function.arguments,
    }));

    return { content, toolCalls, rawToolCalls, finishReason };
  }

  /**
   * Streaming chat completion with tool-calling.
   *
   * Streams `content` tokens (via onToken) while also accumulating any
   * `tool_calls` deltas. Resolves with the same ChatResult shape once the
   * stream ends, so the agent loop can treat it like chatWithTools.
   */
  static async streamChatWithTools(args: StreamChatArgs): Promise<ChatResult> {
    const endpoint = await getEndpoint();

    const body: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      temperature: args.temperature ?? 0.2,
      stream: true,
    };
    if (args.tools && args.tools.length) {
      body.tools = args.tools;
      body.tool_choice = "auto";
    }
    if (typeof args.maxTokens === "number") {
      body.max_tokens = args.maxTokens;
    }
    attachLuczorMeta(body, endpoint, args);

    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify(body),
      signal: args.signal,
    });

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      throw new Error(`OpenRouter HTTP ${res.status}: ${txt || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let content = "";
    let finishReason = "stop";
    const toolAcc: Array<{ id: string; name: string; args: string }> = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep the trailing partial line

      for (const line of lines) {
        const l = line.trim();
        if (!l || l.startsWith(":")) continue; // skip keep-alive comments
        if (!l.startsWith("data:")) continue;

        const data = l.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = json?.choices?.[0];
        const delta = choice?.delta;
        if (choice?.finish_reason) finishReason = String(choice.finish_reason);
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          args.onToken?.(content);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc?.index === "number" ? tc.index : 0;
            const slot = (toolAcc[idx] ??= { id: "", name: "", args: "" });
            if (tc?.id) slot.id = String(tc.id);
            if (tc?.function?.name) slot.name = String(tc.function.name);
            if (typeof tc?.function?.arguments === "string") slot.args += tc.function.arguments;
          }
        }
      }
    }

    const rawToolCalls: WireToolCall[] = toolAcc
      .filter((t) => t && t.name)
      .map((t) => ({
        id: t.id || `call_${Math.random().toString(16).slice(2)}`,
        type: "function" as const,
        function: { name: t.name, arguments: t.args || "{}" },
      }));

    const toolCalls: ParsedToolCall[] = rawToolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseArgs(tc.function.arguments),
      rawArguments: tc.function.arguments,
    }));

    return { content, toolCalls, rawToolCalls, finishReason };
  }
}
