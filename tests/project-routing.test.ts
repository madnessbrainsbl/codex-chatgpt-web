import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { savedChatProjectForCwd, validateSavedChatProjects } from "../src/adapters/chatgpt-web/project-routing";

const url = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-demo/project";
test("saved project bindings match only their local subtree, with the closest root winning", () => {
  const root = resolve("test-workspaces", "one");
  const nested = resolve(root, "nested");
  const secondUrl = url.replace("-demo/", "-nested/");
  const projects = validateSavedChatProjects([{ root, url }, { root: nested, url: secondUrl }]);
  expect(savedChatProjectForCwd(projects, root)).toBe(url);
  expect(savedChatProjectForCwd(projects, resolve(root, "src"))).toBe(url);
  expect(savedChatProjectForCwd(projects, nested)).toBe(secondUrl);
  expect(savedChatProjectForCwd(projects, root + "-other")).toBeUndefined();
  expect(() => validateSavedChatProjects([{ root: "relative", url }])).toThrow();
  expect(() => validateSavedChatProjects([{ root, url: "https://example.com/" }])).toThrow();
  expect(() => validateSavedChatProjects([{ root, url }, { root, url }])).toThrow();
});
