// src/services/tools/registry.ts
//
// Central tool registry for Luczor's agentic loop.
//
// Each ToolDef describes:
//  - the JSON schema the model sees (OpenRouter "function" tool),
//  - whether the tool mutates state (blocked in "observe" mode),
//  - whether it requires explicit user approval before execution,
//  - and how to actually execute it.
//
// Phase 1 ships a small set of SAFE tools (project state). OS-level tools
// (screenshot, input, shell, fs) are added in later phases behind the same
// approval + mode gate this registry already enforces.

import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { mutations, state } from "@/state/store";
import type { ProjectGoal, GoalStatus } from "@/state/types";

/** Last screenshot captured by os_screen_capture, as a data URL (for the UI). */
export const lastScreenshot = ref<string | null>(null);

export type ToolCategory = "os" | "project" | "app" | "custom";

export type ToolContext = {
  projectId: string;
};

export type ToolDef = {
  /** Stable machine name, e.g. "project_set_summary". Sent to the model. */
  name: string;
  category: ToolCategory;
  /** One-line description the model uses to decide when to call the tool. */
  description: string;
  /** JSON Schema for the tool arguments (OpenRouter function.parameters). */
  parameters: Record<string, unknown>;
  /** Mutating tools are hard-blocked while the app is in "observe" mode. */
  mutating: boolean;
  /** When true, the user must approve the call before it executes. */
  requiresApproval: boolean;
  /** Execute the tool. Return value must be JSON-serializable. */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
};

/* -------------------------------------------------
 * Small helpers
 * ------------------------------------------------- */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asGoalStatus(v: unknown): GoalStatus {
  return v === "in_progress" || v === "done" ? v : "open";
}

const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `g_${Math.random().toString(16).slice(2)}`);

/* -------------------------------------------------
 * Tool definitions
 * ------------------------------------------------- */
const TOOLS: ToolDef[] = [
  {
    name: "project_get_state",
    category: "project",
    description:
      "Read the current project state (name, rolling summary, and the list of goals with their status). Use this before proposing changes.",
    mutating: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    async execute(_args, ctx) {
      const prj = getProject(ctx.projectId);
      return {
        id: ctx.projectId,
        name: prj?.name ?? ctx.projectId,
        summary: prj?.summary ?? "",
        goals: (prj?.goals ?? []).map((g) => ({
          id: g.id,
          title: g.title,
          description: g.description ?? "",
          status: g.status,
        })),
      };
    },
  },

  {
    name: "project_set_summary",
    category: "project",
    description:
      "Replace the project's rolling summary with a concise, up-to-date German summary of the project's state and decisions.",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          description: "The new rolling summary (German, concise).",
        },
      },
      required: ["summary"],
    },
    async execute(args, ctx) {
      const summary = asString(args.summary).trim();
      if (!summary) throw new Error("summary is empty");
      mutations.setProjectSummary(ctx.projectId, summary);
      return { ok: true, summary };
    },
  },

  {
    name: "project_upsert_goal",
    category: "project",
    description:
      "Create or update a project goal. Omit id to create a new goal; provide an existing id to update it.",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: "Existing goal id to update. Omit or leave empty to create a new goal.",
        },
        title: { type: "string", description: "Short goal title (German)." },
        description: { type: "string", description: "Optional longer description." },
        status: {
          type: "string",
          enum: ["open", "in_progress", "done"],
          description: "Goal status.",
        },
      },
      required: ["title", "status"],
    },
    async execute(args, ctx) {
      const title = asString(args.title).trim();
      if (!title) throw new Error("title is empty");

      const existingId = asString(args.id).trim();
      const now = Date.now();
      const prj = getProject(ctx.projectId);
      const existing = existingId
        ? (prj?.goals ?? []).find((g) => g.id === existingId)
        : undefined;

      const goal: ProjectGoal = {
        id: existing?.id ?? existingId ?? uid(),
        title,
        description: asString(args.description).trim() || existing?.description,
        status: asGoalStatus(args.status),
        priority: existing?.priority,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        doneAt:
          asGoalStatus(args.status) === "done" ? existing?.doneAt ?? now : null,
      };

      mutations.upsertGoal(ctx.projectId, goal);
      return { ok: true, goal: { id: goal.id, title: goal.title, status: goal.status } };
    },
  },

  /* ===============================================================
   * OS PERCEPTION (read-only, observe-safe)
   * =============================================================== */
  {
    name: "os_read_clipboard",
    category: "os",
    description: "Read the current text content of the system clipboard.",
    mutating: false,
    requiresApproval: false,
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
    async execute() {
      const text = (await invoke<string>("read_clipboard")) ?? "";
      const clipped = text.length > 2000 ? text.slice(0, 2000) + "…" : text;
      return { text: clipped, length: text.length };
    },
  },
  {
    name: "os_list_windows",
    category: "os",
    description:
      "List currently open windows with their title, owning app, and whether they are focused.",
    mutating: false,
    requiresApproval: false,
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
    async execute() {
      const windows = await invoke<unknown[]>("list_windows");
      return { windows };
    },
  },
  {
    name: "os_screen_capture",
    category: "os",
    description:
      "Capture a screenshot of the primary monitor. Returns image dimensions; the image itself is shown in the app.",
    mutating: false,
    requiresApproval: false,
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
    async execute() {
      const shot = await invoke<{ base64: string; mime: string; width: number; height: number }>(
        "capture_screen"
      );
      // Publish the image for the UI, but only return metadata to the model
      // (a full base64 screenshot would flood the context window).
      lastScreenshot.value = `data:${shot.mime};base64,${shot.base64}`;
      return { captured: true, width: shot.width, height: shot.height };
    },
  },

  /* ===============================================================
   * OS CONTROL (mutating -> act mode + approval)
   * =============================================================== */
  {
    name: "os_move_mouse",
    category: "os",
    description: "Move the mouse cursor to an absolute screen position (pixels).",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        x: { type: "number", description: "Absolute X in pixels." },
        y: { type: "number", description: "Absolute Y in pixels." },
      },
      required: ["x", "y"],
    },
    async execute(args) {
      await invoke("move_mouse", { payload: { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) } });
      return { ok: true };
    },
  },
  {
    name: "os_click",
    category: "os",
    description: "Click the mouse. Optionally move to (x,y) first. button = left|right|middle.",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        button: { type: "string", enum: ["left", "right", "middle"] },
        x: { type: "number" },
        y: { type: "number" },
        double: { type: "boolean" },
      },
      required: [],
    },
    async execute(args) {
      await invoke("mouse_click", {
        payload: {
          button: asString(args.button) || "left",
          x: args.x == null ? null : Math.round(Number(args.x)),
          y: args.y == null ? null : Math.round(Number(args.y)),
          double: !!args.double,
        },
      });
      return { ok: true };
    },
  },
  {
    name: "os_type_text",
    category: "os",
    description: "Type text into the currently focused application via simulated keystrokes.",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(args) {
      await invoke("type_text", { payload: { text: asString(args.text) } });
      return { ok: true };
    },
  },
  {
    name: "os_press_key",
    category: "os",
    description:
      "Press a single key: enter, tab, escape, space, backspace, delete, up, down, left, right, home, end, or a single character.",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    async execute(args) {
      await invoke("press_key", { payload: { key: asString(args.key) } });
      return { ok: true };
    },
  },
  {
    name: "os_open_url",
    category: "os",
    description: "Open an http(s) URL with the operating system's default browser.",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(args) {
      await invoke("open_url", { payload: { url: asString(args.url) } });
      return { ok: true };
    },
  },
];

/* -------------------------------------------------
 * Access to project state (read-only helper)
 * ------------------------------------------------- */
function getProject(projectId: string) {
  return state.projects.find((p) => p.id === projectId);
}

/* -------------------------------------------------
 * Public API
 * ------------------------------------------------- */
const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

export function listTools(): ToolDef[] {
  return TOOLS.slice();
}

/**
 * Emit the OpenRouter/OpenAI "tools" array for a chat request.
 */
export function toOpenAITools() {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
