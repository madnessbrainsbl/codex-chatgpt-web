import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { codexChatProject, projectSetupReply } from "../src/adapters/chatgpt-web/project-routing";

const root = resolve("test-workspaces", "native-project");
const state: any = { "local-projects": { local: { name: "Example", rootPaths: [root] } },
  "thread-project-assignments": { member: { projectKind: "local", projectId: "local" } },
  "projectless-thread-ids": ["independent"],
};
test("native project membership, independent chats, and nested workspaces stay distinct", () => {
  expect(codexChatProject(state, "member", resolve(root, "src"))).toMatchObject({ name: "Example", root });
  expect(codexChatProject(state, "independent", root)).toBeUndefined();
  expect(codexChatProject(state, "other", root + "-outside")).toBeUndefined();
  expect(codexChatProject(state, "member", root + "-worktree")?.root).toBe(root);
  const migrated = structuredClone(state);
  migrated["thread-project-assignments"].member.projectId = "app-server-id";
  migrated["app-server-project-id-by-legacy-project-id-by-host"] = { local: { local: "app-server-id" } };
  expect(codexChatProject(migrated, "member", root)?.root).toBe(root);
});
test("native ChatGPT projects route directly; unknown or ambiguous memberships fail closed", () => {
  const native = structuredClone(state);
  native["thread-project-assignments"].member = { projectKind: "chatgpt", projectId: "g-p-0123456789abcdef0123456789abcdef" };
  expect(codexChatProject(native, "member", root)?.url).toBe("https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project");
  native["thread-project-assignments"].member.projectId = "https://example.org";
  expect(() => codexChatProject(native, "member", root)).toThrow();
  const ambiguous = structuredClone(state);
  ambiguous["local-projects"].duplicate = { name: "Other", rootPaths: [root] };
  expect(() => codexChatProject(ambiguous, "unknown", root)).toThrow("ambiguous");
});
test("project setup accepts only an explicit complete project link", () => {
  const url = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-demo/project";
  expect(projectSetupReply(url)).toBe(url);
  expect(projectSetupReply(`[${url}](${url})`)).toBe(url);
  expect(projectSetupReply(`Review this document containing ${url}`)).toBeUndefined();
  expect(projectSetupReply("https://example.com/project")).toBeUndefined();
  expect(projectSetupReply("https://chatgpt.com/s/cx_0123456789abcdef0123456789abcdef")).toBeUndefined();
});
