import type * as Types from "./types";

/* -----------------------------
 * Default State (seed)
 * ----------------------------- */
export const DEFAULT_STATE: Types.AppState = {
  version: 1,

  global: {
    defaults: {
      maxOutputTokens: 1200,
    },
    memories: [
      {
        id: "mem_global_1",
        projectId: null,
        kind: "rule",
        key: "context.strategy",
        value: "Use global memory + project memory + 3-6 summaries + last 8-15 messages; keep prompts small.",
        priority: 5,
        active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: { by: "user" },
      },
      {
        id: "mem_global_2",
        projectId: null,
        kind: "todo_policy",
        key: "todos.confirmation",
        value: "AI may propose todos/steps; user confirms critical/high-risk changes before applying.",
        priority: 5,
        active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: { by: "user" },
      },
      {
        id: "mem_global_3",
        projectId: null,
        kind: "rule",
        key: "context.language",
        value: "Use German for all Texts.",
        priority: 5,
        active: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: { by: "user" },
      },
    ],
  },

  projects: [
    {
      id: "default",
      name: "Default Project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      defaults: {
        maxOutputTokens: 1200,
      },
      focus: {
        activeTodoId: null,
        activeStepId: null,
      },
      archivedAt: null,
    },
  ],

  messages: [],
  todos: [],
  todoSteps: [],
  projectMemories: [],
  summaries: [],

  pending: {
    actionsByProject: {},
  },
};

/* =========================================================
 * Local persistence strategy (no SQL)
 * - Save/load to a single JSON file (preferred in desktop)
 * - Fallback to localStorage for web builds
 * ========================================================= */

export type PersistenceDriver = {
  load(): Promise<Types.AppState | null>;
  save(state: Types.AppState): Promise<void>;
};

export type StorageConfig = {
  // e.g. app data dir path in Electron/Tauri
  stateFilePath?: string;
  // browser fallback key
  localStorageKey?: string;
};

/* =========================================================
 * UI buttons (intended actions)
 * - Add Todo (user)
 * - Add Step (user)
 * - Save as Memory (user)
 * - Promote to Global Memory (user)
 * - Mark Critical Decision (user)
 * - Confirm/Reject AI proposed actions
 * ========================================================= */

export type UiIntent =
  | { type: "ui.todo.create"; projectId: Types.Id; title: string; description?: string; priority?: 1 | 2 | 3 }
  | { type: "ui.todo.step.add"; projectId: Types.Id; todoId: Types.Id; text: string }
  | { type: "ui.todo.step.complete"; projectId: Types.Id; stepId: Types.Id }
  | { type: "ui.memory.upsert"; projectId: Types.Id | null; kind: Types.MemoryKind; key: string; value: string; priority?: 1 | 2 | 3 | 4 | 5 }
  | { type: "ui.focus.set"; projectId: Types.Id; todoId?: Types.Id | null; stepId?: Types.Id | null }
  | { type: "ui.ai.confirmAction"; projectId: Types.Id; actionId: Types.Id }
  | { type: "ui.ai.rejectAction"; projectId: Types.Id; actionId: Types.Id };

/* =========================================================
 * Prompt context builder (default limits)
 * ========================================================= */
export type ContextLimits = {
  globalMemoryMaxChars: number;     // e.g. 1200
  projectMemoryMaxChars: number;    // e.g. 2200
  todoContextMaxChars: number;      // e.g. 1200
  summaryCount: number;             // e.g. 4
  summaryMaxCharsEach: number;      // e.g. 1000
  recentMessagesCount: number;      // e.g. 12
};

export const DEFAULT_LIMITS: ContextLimits = {
  globalMemoryMaxChars: 1200,
  projectMemoryMaxChars: 2200,
  todoContextMaxChars: 1200,
  summaryCount: 4,
  summaryMaxCharsEach: 1000,
  recentMessagesCount: 12,
};

/* =========================================================
 * Confirmation policy (default)
 * - low: auto-apply
 * - medium: auto-apply but show toast
 * - high/critical: require confirmation
 * ========================================================= */
export const shouldRequireConfirmation = (risk: Types.ActionRisk) =>
  risk === "high" || risk === "critical";
