import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertGoal: vi.fn(),
  createProject: vi.fn(),
  createConversation: vi.fn(),
  createTask: vi.fn(),
  state: { projects: [] as any[] },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/state/store", () => ({
  state: mocks.state,
  mutations: {
    upsertGoal: mocks.upsertGoal,
    setProjectSummary: vi.fn(),
    addProject: vi.fn(),
  },
}));
vi.mock("@/services/api/luczorApi", () => ({
  LuczorApi: {
    createProject: mocks.createProject,
    createConversation: mocks.createConversation,
    createTask: mocks.createTask,
  },
}));
vi.mock("@/services/agents", () => ({
  detectAgents: vi.fn(),
  runAgentCli: vi.fn(),
  writeBridgeFile: vi.fn(),
  buildBridgeMarkdown: vi.fn(),
}));

import { getTool, toOpenAITools } from "@/services/tools/registry";

describe("project_upsert_goal", () => {
  beforeEach(() => {
    mocks.upsertGoal.mockReset();
    mocks.createProject.mockReset().mockResolvedValue({ data: {} });
    mocks.createConversation.mockReset().mockResolvedValue({ data: { external_id: "chat-1" } });
    mocks.createTask.mockReset().mockResolvedValue({ data: { external_id: "task-1" } });
    mocks.state.projects = [{ id: "project-1", name: "Projekt 1", goals: [] }];
  });

  it("generates a non-empty id when the model omits id", async () => {
    const result = await getTool("project_upsert_goal")!.execute(
      { title: "Luczor optimieren", status: "open" },
      { projectId: "project-1" }
    ) as { goal: { id: string } };

    expect(result.goal.id).not.toBe("");
    expect(mocks.upsertGoal.mock.calls[0]![1].id).toBe(result.goal.id);
  });

  it("does not emit empty properties objects that Nvidia rejects", () => {
    for (const tool of toOpenAITools()) {
      const parameters = tool.function.parameters as { properties?: Record<string, unknown> };
      expect(Object.keys(parameters.properties ?? {}), tool.function.name).not.toHaveLength(0);
    }
  });

  it("aligns and uses the current project when task_create omits project_id", async () => {
    await getTool("task_create")!.execute(
      { title: "Tests schreiben" },
      { projectId: "project-1" }
    );

    expect(mocks.createProject).toHaveBeenCalledWith("project-1", "Projekt 1");
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Tests schreiben",
      project_id: "project-1",
    }));
  });

  it("also aligns the current project when the model passes its id explicitly", async () => {
    await getTool("task_create")!.execute(
      { title: "Tests schreiben", project_id: "project-1" },
      { projectId: "project-1" }
    );

    expect(mocks.createProject).toHaveBeenCalledWith("project-1", "Projekt 1");
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({
      project_id: "project-1",
    }));
  });

  it("aligns and uses the current project when chat_create omits project_id", async () => {
    await getTool("chat_create")!.execute({}, { projectId: "project-1" });

    expect(mocks.createProject).toHaveBeenCalledWith("project-1", "Projekt 1");
    expect(mocks.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      project_id: "project-1",
    }));
  });
});
