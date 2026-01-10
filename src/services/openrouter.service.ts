import { Store } from "@tauri-apps/plugin-store";

/* -------------------------------------------------
 * Types
 * ------------------------------------------------- */
export type ORole = "system" | "user" | "assistant";
export type OMessage = { role: ORole; content: string };

export type LuczorMode = "observe" | "plan" | "execute";

/**
 * STRICT schema-friendly:
 * - All top-level keys are ALWAYS present
 * - "plan" can be null
 * - arrays default to []
 * - question default to ""
 */
export type LuczorEnvelope = {
  mode: LuczorMode;
  summary: string;
  bullets: string[];
  plan: { steps: string[] } | null;
  actions: Array<{
    type: string;
    risk: "low" | "medium" | "high";
    requires_approval: boolean;
  }>;
  question: string;
};

type StreamChatOptions = {
  model: string;
  messages: OMessage[];
  mode: LuczorMode;

  onToken: (token: string) => void; // called once (non-stream)
  onDone?: (rawText: string) => void;
  onStructured?: (env: LuczorEnvelope) => void;
  onError?: (msg: string) => void;

  signal?: AbortSignal;
};

type OpenRouterSettings = {
  apiKey: string;
  apiBaseUrl: string;
  referer: string;
  title: string;
};

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* -------------------------------------------------
 * Service
 * ------------------------------------------------- */
export class OpenRouterService {
  private static store: Store | null = null;

  private static async getStore() {
    if (!this.store) this.store = await Store.load("luczor.settings.json");
    return this.store;
  }

  private static async getSettings(): Promise<OpenRouterSettings> {
    const store = await this.getStore();

    const apiKey = (await store.get<string>("openrouter_api_key"))?.trim();
    if (!apiKey) throw new Error("OpenRouter API Key fehlt.");

    const apiBaseUrl =
      (await store.get<string>("openrouter_api_base_url"))?.trim() ||
      "https://openrouter.ai/api/v1";

    const referer =
      (await store.get<string>("openrouter_referer"))?.trim() || "http://localhost";

    const title =
      (await store.get<string>("openrouter_title"))?.trim() || "Luczor";

    return { apiKey, apiBaseUrl, referer, title };
  }

  /**
   * Non-stream call, but keeps your callback contract.
   * Uses chat/completions + response_format json_schema strict.
   */
  static async streamChat(opts: StreamChatOptions): Promise<{ cancel: () => Promise<void> }> {
    const { apiKey, apiBaseUrl, referer, title } = await this.getSettings();

    const controller = new AbortController();
    const externalSignal = opts.signal;

    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const cancel = async () => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    };

    const systemInstruction = buildStructuredInstruction(opts.mode);

    const body = {
      model: opts.model,
      messages: [
        { role: "system" as const, content: systemInstruction },
        ...opts.messages,
      ],
      stream: false,

      response_format: {
        type: "json_schema",
        json_schema: {
          name: "LuczorEnvelope",
          strict: true,
          schema: luczorEnvelopeJsonSchemaStrict(opts.mode),
        },
      },
    };

    let rawText = "";

    try {
      const res = await fetch(`${apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": referer,
          "X-Title": title,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        opts.onError?.(text || `HTTP ${res.status}`);
        throw new Error(text || `HTTP ${res.status}`);
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;

      if (typeof content === "string") rawText = content;
      else if (isObject(content)) rawText = JSON.stringify(content);
      else rawText = JSON.stringify(json);

      opts.onToken(rawText);
      opts.onDone?.(rawText);

      const env = normalizeLuczorEnvelope(rawText, opts.mode);
      if (env) opts.onStructured?.(env);

      return { cancel };
    } catch (e: any) {
      if (e?.name === "AbortError") {
        opts.onDone?.(rawText);
        return { cancel };
      }

      opts.onError?.(e?.message ?? String(e));
      throw e;
    }
  }
}

/* -------------------------------------------------
 * Strict Schema (ALL KEYS REQUIRED)
 * ------------------------------------------------- */
function luczorEnvelopeJsonSchemaStrict(mode: LuczorMode) {
  const actionItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      requires_approval: { type: "boolean" },
    },
    required: ["type", "risk", "requires_approval"],
  } as const;

  const planObj = {
    type: "object",
    additionalProperties: false,
    properties: {
      steps: { type: "array", items: { type: "string" } },
    },
    required: ["steps"],
  } as const;

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["observe", "plan", "execute"], default: mode },
      summary: { type: "string" },

      bullets: { type: "array", items: { type: "string" } },

      // plan may be object OR null, but still required
      plan: { anyOf: [planObj, { type: "null" }] },

      actions: { type: "array", items: actionItem },

      question: { type: "string" },
    },

    // REQUIRED MUST include ALL keys in properties
    required: ["mode", "summary", "bullets", "plan", "actions", "question"],
  } as const;
}

/* -------------------------------------------------
 * Normalize output (force defaults)
 * ------------------------------------------------- */
function normalizeLuczorEnvelope(raw: string, fallbackMode: LuczorMode): LuczorEnvelope | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const mode: LuczorMode =
    parsed.mode === "observe" || parsed.mode === "plan" || parsed.mode === "execute"
      ? parsed.mode
      : fallbackMode;

  const summary = typeof parsed.summary === "string" ? parsed.summary : "";

  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets.filter((x: any) => typeof x === "string").slice(0, 5)
    : [];

  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
        .filter((a: any) => isObject(a) && typeof a.type === "string")
        .map((a: any) => ({
          type: String(a.type),
          risk: a.risk === "low" || a.risk === "medium" || a.risk === "high" ? a.risk : "medium",
          requires_approval: Boolean(a.requires_approval),
        }))
        .slice(0, 8)
    : [];

  let plan: { steps: string[] } | null = null;
  if (parsed.plan === null) {
    plan = null;
  } else if (isObject(parsed.plan) && Array.isArray((parsed.plan as any).steps)) {
    plan = {
      steps: (parsed.plan as any).steps.filter((x: any) => typeof x === "string").slice(0, 6),
    };
  } else {
    plan = null;
  }

  const question = typeof parsed.question === "string" ? parsed.question : "";

  // Ensure required values exist (even if empty)
  return {
    mode,
    summary,
    bullets,
    plan,
    actions,
    question,
  };
}

/* -------------------------------------------------
 * Prompt helper
 * ------------------------------------------------- */
export function buildStructuredInstruction(mode: LuczorMode): string {
  return ``.trim();
}
