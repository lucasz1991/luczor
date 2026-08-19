import { describe, expect, it } from "vitest";
import {
  buildPlanContext,
  currentPlanStep,
  emptyPlan,
  isPlanComplete,
  normalizeSteps,
  planProgress,
  planState,
  setPlan,
  type Plan,
} from "./plan";

function plan(steps: Plan["steps"]): Plan {
  return { steps, note: "", updatedAt: 0 };
}

describe("normalizeSteps", () => {
  it("accepts plain strings as pending steps", () => {
    expect(normalizeSteps(["eins", "zwei"]).steps).toEqual([
      { title: "eins", status: "pending" },
      { title: "zwei", status: "pending" },
    ]);
  });

  it("keeps only the first in_progress step and reports the repair", () => {
    const result = normalizeSteps([
      { title: "a", status: "in_progress" },
      { title: "b", status: "in_progress" },
      { title: "c", status: "in_progress" },
    ]);
    expect(result.steps.map((s) => s.status)).toEqual(["in_progress", "pending", "pending"]);
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0]).toContain("2 weitere");
  });

  it("does not report a repair for a single in_progress step", () => {
    const result = normalizeSteps([
      { title: "a", status: "done" },
      { title: "b", status: "in_progress" },
    ]);
    expect(result.repairs).toEqual([]);
  });

  it("coerces unknown status values to pending", () => {
    expect(normalizeSteps([{ title: "a", status: "wat" }]).steps[0]?.status).toBe("pending");
  });

  it("drops entries without a title", () => {
    expect(normalizeSteps([{ title: "   " }, { status: "done" }, "ok"]).steps).toEqual([
      { title: "ok", status: "pending" },
    ]);
  });

  it("caps the plan length and reports it", () => {
    const many = Array.from({ length: 40 }, (_, i) => `s${i}`);
    const result = normalizeSteps(many);
    expect(result.steps).toHaveLength(24);
    expect(result.repairs[0]).toContain("gekürzt");
  });

  it("tolerates non-array input", () => {
    expect(normalizeSteps(null).steps).toEqual([]);
    expect(normalizeSteps("nope").steps).toEqual([]);
  });

  it("accepts alternative title keys the model tends to invent", () => {
    expect(normalizeSteps([{ step: "aus step" }, { name: "aus name" }]).steps).toEqual([
      { title: "aus step", status: "pending" },
      { title: "aus name", status: "pending" },
    ]);
  });
});

describe("plan progress helpers", () => {
  it("counts done and skipped as resolved", () => {
    const p = plan([
      { title: "a", status: "done" },
      { title: "b", status: "skipped" },
      { title: "c", status: "pending" },
    ]);
    expect(planProgress(p)).toEqual({ done: 2, total: 3, percent: 67 });
  });

  it("reports zero progress for an empty plan without dividing by zero", () => {
    expect(planProgress(emptyPlan())).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it("finds the active step", () => {
    const p = plan([
      { title: "a", status: "done" },
      { title: "b", status: "in_progress" },
    ]);
    expect(currentPlanStep(p)?.title).toBe("b");
    expect(currentPlanStep(emptyPlan())).toBeNull();
  });

  it("treats a fully skipped plan as complete but an empty plan as not", () => {
    expect(isPlanComplete(plan([{ title: "a", status: "skipped" }]))).toBe(true);
    expect(isPlanComplete(emptyPlan())).toBe(false);
  });
});

describe("setPlan / buildPlanContext", () => {
  it("stores a normalized plan per project", () => {
    const result = setPlan("p1", [
      { title: "erster", status: "in_progress" },
      { title: "zweiter", status: "in_progress" },
    ]);
    expect(result.repairs).toHaveLength(1);
    expect(planState.byProject.p1?.steps.map((s) => s.status)).toEqual(["in_progress", "pending"]);
  });

  it("renders a compact context block with status glyphs", () => {
    setPlan("p2", [
      { title: "fertig", status: "done" },
      { title: "läuft", status: "in_progress" },
      { title: "offen", status: "pending" },
    ], "kurze notiz");
    const text = buildPlanContext("p2");
    expect(text).toContain("1/3 erledigt");
    expect(text).toContain("1. [x] fertig");
    expect(text).toContain("2. [>] läuft");
    expect(text).toContain("3. [ ] offen");
    expect(text).toContain("Notiz: kurze notiz");
  });

  it("returns an empty context when no plan exists", () => {
    expect(buildPlanContext("unknown-project")).toBe("");
  });
});
