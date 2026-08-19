// src/services/plan.ts
//
// Codex-style task planning.
//
// The model maintains a short, visible checklist for multi-step work via the
// `plan_update` tool. This is a PRESENTATION surface, not a system change:
// it never touches the OS, the server, or project data, so it deliberately
// carries `mutating: false` / no approval — otherwise every status tick would
// interrupt the user with a confirmation dialog.
//
// Invariant enforced here (not trusted from the model): AT MOST ONE step may
// be `in_progress`. The model routinely forgets this, so `setPlan` repairs the
// input and reports what it changed, and the repair is fed back as the tool
// result so the model can self-correct.
//
// Plans are per project and persisted separately from the chat AppState, so no
// store migration is required.

import { reactive } from "vue";
import { Store } from "@tauri-apps/plugin-store";

const PLAN_STORE_FILE = "luczor.plan.json";
const MAX_STEPS = 24;
const MAX_TITLE = 160;
const MAX_NOTE = 400;

export type PlanStepStatus = "pending" | "in_progress" | "done" | "skipped";

export type PlanStep = {
  title: string;
  status: PlanStepStatus;
};

export type Plan = {
  steps: PlanStep[];
  /** Optional one-line note about the current state of the work. */
  note: string;
  updatedAt: number;
};

type PlanState = {
  byProject: Record<string, Plan>;
  loaded: boolean;
};

export const planState = reactive<PlanState>({
  byProject: {},
  loaded: false,
});

/* -------------------------------------------------
 * Helpers
 * ------------------------------------------------- */
function asStatus(value: unknown): PlanStepStatus {
  return value === "in_progress" || value === "done" || value === "skipped"
    ? value
    : "pending";
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function emptyPlan(): Plan {
  return { steps: [], note: "", updatedAt: 0 };
}

export function getPlan(projectId: string): Plan {
  return planState.byProject[projectId] ?? emptyPlan();
}

export function planProgress(plan: Plan): { done: number; total: number; percent: number } {
  const total = plan.steps.length;
  // Skipped steps count as resolved: otherwise a plan with a deliberately
  // skipped step can never reach 100 % and looks stuck.
  const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

export function currentPlanStep(plan: Plan): PlanStep | null {
  return plan.steps.find((s) => s.status === "in_progress") ?? null;
}

export function isPlanComplete(plan: Plan): boolean {
  return plan.steps.length > 0 && plan.steps.every((s) => s.status === "done" || s.status === "skipped");
}

/* -------------------------------------------------
 * Normalisation (the actual guard)
 * ------------------------------------------------- */
export type PlanNormalizeResult = {
  steps: PlanStep[];
  /** Human-readable notes about repairs applied to the model's input. */
  repairs: string[];
};

/**
 * Coerce arbitrary model input into a valid plan.
 * Exported for tests — this is where the single-`in_progress` rule lives.
 */
export function normalizeSteps(input: unknown): PlanNormalizeResult {
  const repairs: string[] = [];
  const raw = Array.isArray(input) ? input : [];

  let steps: PlanStep[] = raw
    .map((entry) => {
      if (typeof entry === "string") return { title: clip(entry, MAX_TITLE), status: "pending" as PlanStepStatus };
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        title: clip(record.title ?? record.step ?? record.name, MAX_TITLE),
        status: asStatus(record.status),
      };
    })
    .filter((step) => step.title.length > 0);

  if (steps.length > MAX_STEPS) {
    repairs.push(`Plan auf ${MAX_STEPS} Schritte gekürzt (${steps.length} übergeben).`);
    steps = steps.slice(0, MAX_STEPS);
  }

  // Enforce: at most one in_progress. Keep the FIRST one, demote the rest to
  // pending so no work silently looks finished.
  const active = steps.filter((s) => s.status === "in_progress");
  if (active.length > 1) {
    let seen = false;
    steps = steps.map((step) => {
      if (step.status !== "in_progress") return step;
      if (!seen) {
        seen = true;
        return step;
      }
      return { ...step, status: "pending" as PlanStepStatus };
    });
    repairs.push(
      `Nur ein Schritt darf gleichzeitig "in_progress" sein; ${active.length - 1} weitere wurden auf "pending" zurückgesetzt.`
    );
  }

  return { steps, repairs };
}

/* -------------------------------------------------
 * Persistence
 * ------------------------------------------------- */
// Portable timer handle: this module must also load in a plain Node context
// (unit tests, SSR-style tooling) where `window` does not exist.
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function persist(): Promise<void> {
  try {
    const store = await Store.load(PLAN_STORE_FILE);
    await store.set("byProject", planState.byProject);
    await store.save();
  } catch (error) {
    console.warn("[plan] persist failed:", error);
  }
}

function schedulePersist(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persist();
  }, 400);
  // Never hold the Node process / test runner open for a debounce timer.
  (saveTimer as unknown as { unref?: () => void })?.unref?.();
}

/** Restore persisted plans. Safe to call more than once. */
export async function loadPlans(): Promise<void> {
  if (planState.loaded) return;
  planState.loaded = true;
  try {
    const store = await Store.load(PLAN_STORE_FILE);
    const stored = await store.get<Record<string, Plan>>("byProject");
    if (!stored || typeof stored !== "object") return;
    for (const [projectId, plan] of Object.entries(stored)) {
      const { steps } = normalizeSteps(plan?.steps);
      planState.byProject[projectId] = {
        steps,
        note: clip(plan?.note, MAX_NOTE),
        updatedAt: Number(plan?.updatedAt) || 0,
      };
    }
  } catch (error) {
    console.warn("[plan] load failed:", error);
  }
}

/* -------------------------------------------------
 * Mutations
 * ------------------------------------------------- */
export type SetPlanResult = {
  plan: Plan;
  repairs: string[];
};

/** Replace the plan for a project, repairing invalid model input. */
export function setPlan(projectId: string, steps: unknown, note?: unknown): SetPlanResult {
  const { steps: normalized, repairs } = normalizeSteps(steps);
  const plan: Plan = {
    steps: normalized,
    note: clip(note, MAX_NOTE),
    updatedAt: Date.now(),
  };
  planState.byProject[projectId] = plan;
  schedulePersist();
  return { plan, repairs };
}

/** Remove the plan for a project (used by the UI "clear" affordance). */
export function clearPlan(projectId: string): void {
  delete planState.byProject[projectId];
  schedulePersist();
}

/**
 * Compact plan text for the model's system context, so the plan survives
 * across turns without the model having to re-read tool history.
 */
export function buildPlanContext(projectId: string): string {
  const plan = getPlan(projectId);
  if (!plan.steps.length) return "";
  const { done, total } = planProgress(plan);
  const glyph: Record<PlanStepStatus, string> = {
    done: "[x]",
    in_progress: "[>]",
    skipped: "[-]",
    pending: "[ ]",
  };
  const lines = plan.steps.map((step, index) => `${index + 1}. ${glyph[step.status]} ${step.title}`);
  return [
    `[AKTUELLER PLAN] ${done}/${total} erledigt.`,
    ...lines,
    plan.note ? `Notiz: ${plan.note}` : "",
    'Halte den Plan über das Tool "plan_update" aktuell. Genau ein Schritt ist "in_progress".',
  ]
    .filter(Boolean)
    .join("\n");
}
