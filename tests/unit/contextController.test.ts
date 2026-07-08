import { describe, expect, it } from "vitest";
import { inferTaskType } from "@/services/contextController";

describe("inferTaskType", () => {
  it("classifies coding bug tasks", () => {
    expect(inferTaskType("Bitte den Build Fehler in App.vue fixen")).toBe("coding.fix_bug");
  });

  it("classifies planning tasks", () => {
    expect(inferTaskType("Erstelle eine Architektur Planung für den nächsten MVP")).toBe(
      "planning.architecture"
    );
  });
});
