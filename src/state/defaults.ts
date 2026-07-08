// src/state/defaults.ts
import type * as Types from "./types";

/* -----------------------------
 * helpers
 * ----------------------------- */
const now = () => Date.now();

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
        value:
          "Use global memory + project memory + last messages; keep prompts small.",
        priority: 5,
        active: true,
        createdAt: now(),
        updatedAt: now(),
        source: { by: "user" },
      },
      {
        id: "mem_global_2",
        projectId: null,
        kind: "todo_policy",
        key: "execution.confirmation",
        value:
          "Tool calls are always proposed; user must approve before execution.",
        priority: 5,
        active: true,
        createdAt: now(),
        updatedAt: now(),
        source: { by: "user" },
      },
      {
        id: "mem_global_3",
        projectId: null,
        kind: "rule",
        key: "context.language",
        value: "Default language: German.",
        priority: 5,
        active: true,
        createdAt: now(),
        updatedAt: now(),
        source: { by: "user" },
      },
    ],
    ui: {
      lastProjectId: "default",
    },
  },

  projects: [
    {
      id: "default",
      name: "Default Project",
      goal: undefined,
      goals: [],
      summary: "",
      defaults: {
        maxOutputTokens: 1200,
      },
      focus: {
        activeTodoId: null,
        activeStepId: null,
      },
      archivedAt: null,
      createdAt: now(),
      updatedAt: now(),
    },
  ],

  messages: [],

  // optional legacy / future features
  todos: [],
  todoSteps: [],
  projectMemories: [],

  summaries: [],

  pending: {
    toolCallsByProject: {},
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
  stateFilePath?: string;
  localStorageKey?: string;
};
