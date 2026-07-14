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
    fileRead: vi.fn(async () => ({ content: "hello", bytes: 5, truncated: false })),
    fileWrite: vi.fn(async () => ({ path: "note.txt", bytes: 3 })),
    runScript: vi.fn(async () => ({ ok: true, code: 0, stdout: "42", stderr: "", timed_out: false })),
    browserOpen: vi.fn(async () => ({ ok: true })),
    browserClick: vi.fn(async () => ({ ok: true })),
    browserRead: vi.fn(async () => ({ ok: true, text: "page text", truncated: false })),
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

describe("browser tasks drive the in-app browser (SOLL P24)", () => {
  it("opens the window then clicks the selector", async () => {
    const p = primitives();
    const result = await runWorkflowTask(bundle("browser.click", { selector: "#go", url: "https://example.org" }), p);
    expect(p.browserOpen).toHaveBeenCalledWith("https://example.org");
    expect(p.browserClick).toHaveBeenCalledWith("#go");
    expect(result).toMatchObject({ ok: true, clicked: "#go" });
  });

  it("reads element text via the browser", async () => {
    const p = primitives({ browserRead: vi.fn(async () => ({ ok: true, text: "headline", truncated: false })) });
    const result = await runWorkflowTask(bundle("browser.read", { selector: "h1" }), p);
    expect(p.browserRead).toHaveBeenCalledWith("h1");
    expect(result).toMatchObject({ ok: true, text: "headline" });
  });

  it("browser.click requires a selector", async () => {
    await expect(runWorkflowTask(bundle("browser.click", {}), primitives())).rejects.toThrow(/selector/i);
  });
});

describe("filesystem tasks (SOLL P15b)", () => {
  it("reads a confined file", async () => {
    const p = primitives();
    const result = await runWorkflowTask(bundle("file.read", { path: "notes/a.txt" }), p);
    expect(p.fileRead).toHaveBeenCalledWith("notes/a.txt");
    expect(result).toMatchObject({ ok: true, content: "hello", bytes: 5 });
  });

  it("writes a confined file", async () => {
    const p = primitives();
    const result = await runWorkflowTask(bundle("file.write", { path: "out.txt", content: "hi" }), p);
    expect(p.fileWrite).toHaveBeenCalledWith("out.txt", "hi");
    expect(result).toMatchObject({ ok: true });
  });

  it("file.read requires a path", async () => {
    await expect(runWorkflowTask(bundle("file.read", {}), primitives())).rejects.toThrow(/path/i);
  });
});

describe("local runtime tasks (SOLL P15b)", () => {
  it("runs python code", async () => {
    const p = primitives({ runScript: vi.fn(async () => ({ ok: true, code: 0, stdout: "42", stderr: "", timed_out: false })) });
    const result = await runWorkflowTask(bundle("python.run", { code: "print(42)", timeout_seconds: 10 }), p);
    expect(p.runScript).toHaveBeenCalledWith("python", "print(42)", 10);
    expect(result).toMatchObject({ ok: true, stdout: "42", timed_out: false });
  });

  it("maps node.run to the node runtime", async () => {
    const p = primitives();
    await runWorkflowTask(bundle("node.run", { code: "console.log(1)" }), p);
    expect(p.runScript).toHaveBeenCalledWith("node", "console.log(1)", undefined);
  });

  it("python.run requires code", async () => {
    await expect(runWorkflowTask(bundle("python.run", {}), primitives())).rejects.toThrow(/code/i);
  });
});

describe("unknown tasks fail honestly", () => {
  it("throws for an unknown task key", async () => {
    await expect(runWorkflowTask(bundle("shell.rm_rf"), primitives())).rejects.toThrow(/Unsupported/);
  });
});
