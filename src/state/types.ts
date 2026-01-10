/* =========================================================
 * Defaults: Data model + in-memory/local-file store
 * - Project == Conversation
 * - Global memory + per-project memory
 * - AI proposes todos/memory via actions; critical changes require user confirmation
 * - User can also set todos/memory via UI buttons
 * - No SQL: persist to local JSON file (or localStorage as fallback)
 * ========================================================= */

/* -----------------------------
 * Core Types
 * ----------------------------- */
export type Id = string;

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type Message = {
  id: Id;
  projectId: Id;
  role: ChatRole;
  content: string;
  createdAt: number;

  // Optional: raw model payloads, parsing results, etc.
  meta?: {
    model?: string;
    latencyMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    // actions proposed/executed for traceability
    proposedActions?: AiAction[];
    executedActions?: ExecutedAction[];
  };
};

export type Project = {
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;

  defaults: {
    maxOutputTokens: number;
  };

  // Active focus for step-by-step work
  focus?: {
    activeTodoId?: Id | null;
    activeStepId?: Id | null;
  };

  archivedAt?: number | null;
};

/* -----------------------------
 * Todo Model
 * ----------------------------- */
export type TodoStatus = "open" | "in_progress" | "done" | "blocked";
export type StepStatus = "open" | "done";

export type Todo = {
  id: Id;
  projectId: Id;

  title: string;
  description?: string;

  status: TodoStatus;
  priority: 1 | 2 | 3;

  createdAt: number;
  updatedAt: number;

  // For traceability
  source?: {
    messageId?: Id;
    by: "user" | "ai";
  };

  // Critical items require explicit confirmation before activation
  flags?: {
    critical?: boolean;
  };
};

export type TodoStep = {
  id: Id;
  todoId: Id;

  text: string;
  status: StepStatus;
  position: number;

  updatedAt: number;

  source?: {
    messageId?: Id;
    by: "user" | "ai";
  };
};

/* -----------------------------
 * Memory Model (Global + Project)
 * ----------------------------- */
export type MemoryKind = "preference" | "constraint" | "rule" | "decision" | "workflow" | "todo_policy";

export type MemoryEntry = {
  id: Id;

  // If projectId is null => global memory
  projectId: Id | null;

  kind: MemoryKind;
  key: string;    // e.g. "naming.projectName", "stack.frontend"
  value: string;  // short, 1-2 sentences, or compact JSON string

  priority: 1 | 2 | 3 | 4 | 5; // 5 is always included in prompt
  active: boolean;

  createdAt: number;
  updatedAt: number;

  source?: {
    messageId?: Id;
    by: "user" | "ai";
  };
};

/* -----------------------------
 * AI Action System
 * ----------------------------- */
export type AiActionType =
  | "todo.create"
  | "todo.update"
  | "todo.complete"
  | "todo.step.add"
  | "todo.step.update"
  | "todo.step.complete"
  | "focus.set"
  | "memory.upsert"
  | "memory.deactivate"
  | "summary.create"; // optional: rolling summary

// Classification for confirmation flow
export type ActionRisk = "low" | "medium" | "high" | "critical";

export type AiAction = {
  id: Id;
  type: AiActionType;

  // used for "ask user to confirm" gating
  risk: ActionRisk;

  // short explanation for UI confirmation dialog
  rationale: string;

  // JSON payload depends on action type (validated client-side)
  payload: Record<string, any>;
};

export type ExecutedAction = {
  actionId: Id;
  executedAt: number;
  status: "applied" | "rejected" | "failed";
  error?: string;
};

/* -----------------------------
 * Summaries (rolling compression)
 * ----------------------------- */
export type Summary = {
  id: Id;
  projectId: Id;
  rangeStartTs: number;
  rangeEndTs: number;

  // keep it short; hard cap enforced when storing
  text: string;

  createdAt: number;
};

/* -----------------------------
 * App State (single JSON file)
 * ----------------------------- */
export type AppState = {
  version: 1;

  // Global defaults (apply if project has no override)
  global: {
    defaults: {
      maxOutputTokens: number;
    };

    // memory: only "basic" things, small
    memories: MemoryEntry[];

    // optional: global UI flags
    ui?: {
      lastProjectId?: Id | null;
    };
  };

  projects: Project[];
  messages: Message[];
  todos: Todo[];
  todoSteps: TodoStep[];
  projectMemories: MemoryEntry[]; // projectId != null
  summaries: Summary[];

  // Pending AI actions awaiting confirmation
  pending: {
    // keyed by projectId
    actionsByProject: Record<Id, AiAction[]>;
  };
};

