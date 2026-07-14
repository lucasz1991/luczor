import { describe, expect, it, vi } from "vitest";
import {
  isWorkflowTaskBundle,
  runWorkflowTask,
  type WorkflowTaskBundle,
  type WorkflowTaskPrimitives,
} from "@/services/workflowTaskRunner";

const bundle = (task_key: string, params: Record<string, unknown> = {}): WorkflowTaskBundle => ({
  task_key,
  params,
  workflow: { run: "run-1", step_id: 7, step_key: "open" },
});

function primitives(overrides: Partial<WorkflowTaskPrimitives> = {}): WorkflowTaskPrimitives {
  return {
    openUrl: vi.fn(async () => {}),
    httpFetch: vi.fn(async () => ({ status: 200, ok: true, body: "{}" })),
    runAgent: vi.fn(async () => ({ ok: true, code: 0, stdout: "done", stderr: "" })),
    ...overrides,
  };
}

describe("workflow.task bundle guard", () => {
  it("accepts a well-formed bundle and rejects junk", () => {
    expect(isWorkflowTaskBundle(bundle("api.call"))).toBe(true);
    expect(isWorkflowTaskBundle({ task_key: "api.call" })).toBe(false);
    expect(isWorkflowTaskBundle(null)).toBe(false);
    expect(isWorkflowTaskBundle({ params: {} })).toBe(false);
  });
});

describe("browser tasks", () => {
  it("opens a validated http(s) url for browser.open_url", async () => {
    const p = primitives();
    const result = await runWorkflowTask(bundle("browser.open_url", { url: "https://example.org" }), p);
    expect(p.openUrl).toHaveBeenCalledWith("https://example.org");
    expect(result).toMatchObject({ ok: true, opened: "https://example.org" });
  });

  it("rejects a non-http url", async () => {
    const p = primitives();
    await expect(runWorkflowTask(bundle("browser.open_url", { url: "file:///etc/passwd" }), p)).rejects.toThrow(/http/i);
    expect(p.openUrl).not.toHaveBeenCalled();
  });

  it("opens about:blank for browser.open without a url", async () => {
    const p = primitives();
    const result = await runWorkflowTask(bundle("browser.open", {}), p);
    expect(p.openUrl).toHaveBeenCalledWith("about:blank");
    expect(result).toMatchObject({ opened: "about:blank" });
  });
});

describe("api.call", () => {
  it("performs the request and returns a capped body", async () => {
    const p = primitives({ httpFetch: vi.fn(async () => ({ status: 201, ok: true, body: "created" })) });
    const result = await runWorkflowTask(
      bundle("api.call", { method: "post", url: "https://api.example.org/x", headers: { "X-Test": "1" }, body: { a: 1 } }),
      p,
    );
    expect(p.httpFetch).toHaveBeenCalledWith("POST", "https://api.example.org/x", { "X-Test": "1" }, '{"a":1}');
    expect(result).toMatchObject({ ok: true, status: 201, body: "created", truncated: false });
  });

  it("truncates an oversized response body", async () => {
    const big = "x".repeat(25_000);
    const p = primitives({ httpFetch: vi.fn(async () => ({ status: 200, ok: true, body: big })) });
    const result = await runWorkflowTask(bundle("api.call", { url: "https://api.example.org" }), p);
    expect((result.body as string).length).toBe(20_000);
    expect(result.truncated).toBe(true);
  });
});

describe("agent.dispatch", () => {
  it("runs the agent with prompt and project dir", async () => {
    const p = primitives();
    const result = await runWorkflowTask(
      bundle("agent.dispatch", { agent: "codex", prompt: "Fix the bug", project_dir: "/tmp/proj" }),
      p,
    );
    expect(p.runAgent).toHaveBeenCalledWith("codex", "Fix the bug", "/tmp/proj");
    expect(result).toMatchObject({ ok: true, code: 0, stdout: "done" });
  });

  it("fails when the prompt is empty", async () => {
    await expect(runWorkflowTask(bundle("agent.dispatch", { agent: "claude", prompt: "  " }), primitives())).rejects.toThrow(/prompt/i);
  });
});

describe("tasks the device build cannot do yet fail honestly", () => {
  it.each(["browser.click", "browser.read", "file.read", "file.write", "python.run", "node.run"])(
    "throws an explanatory error for %s",
    async (key) => {
      await expect(runWorkflowTask(bundle(key), primitives())).rejects.toThrow();
    },
  );

  it("throws for an unknown task key", async () => {
    await expect(runWorkflowTask(bundle("shell.rm_rf"), primitives())).rejects.toThrow(/Unsupported/);
  });
});
