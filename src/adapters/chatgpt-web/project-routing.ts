import { isAbsolute, relative, resolve } from "node:path";
import { chatGptProjectUrl } from "../../chatgpt-session";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";

export interface SavedChatProject { root: string; url: string }
export interface CodexChatProject { name: string; root: string; url?: string }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contains(root: string, cwd: string): boolean {
  const rel = relative(root, resolve(cwd));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Native sidebar membership distinguishes an independent chat from a project sharing its cwd. */
export function codexChatProject(state: unknown, threadId: string, cwd: string): CodexChatProject | undefined {
  const data = record(state);
  const assignment = record(record(data["thread-project-assignments"])[threadId]);
  if (assignment.projectKind === "chatgpt") {
    if (typeof assignment.projectId !== "string" || !/^g-p-[a-f0-9]{32}$/.test(assignment.projectId)) {
      throw new Error("Invalid native ChatGPT project membership");
    }
    return { name: assignment.projectId, root: resolve(cwd), url: chatGptProjectUrl(`https://chatgpt.com/g/${assignment.projectId}/project`) };
  }
  if (!assignment.projectKind && Array.isArray(data["projectless-thread-ids"]) && data["projectless-thread-ids"].includes(threadId)) return undefined;
  const aliases = Object.values(record(data["app-server-project-id-by-legacy-project-id-by-host"])).map(record);
  const local = record(data["local-projects"]);
  const projects = Object.entries(local).flatMap(([id, value]) => {
    const project = record(value);
    if (typeof project.name !== "string" || !Array.isArray(project.rootPaths)) return [];
    return project.rootPaths.filter((root: unknown): root is string => typeof root === "string" && isAbsolute(root))
      .map((root: string) => ({ id, name: project.name as string, root: resolve(root) }));
  });
  if (assignment.projectKind === "local") {
    const matches = projects.filter(project => project.id === assignment.projectId
      || aliases.some(alias => alias[project.id] === assignment.projectId));
    if (!matches.length) throw new Error("Native Codex project is missing from the local project catalog");
    // Assigned worktrees may live outside the original root; membership never grants filesystem access.
    return matches.sort((a, b) => Number(contains(b.root, cwd)) - Number(contains(a.root, cwd)) || b.root.length - a.root.length)[0];
  }
  if (assignment.projectKind !== undefined) throw new Error("Unsupported native Codex project membership");
  const matches = projects.filter(project => contains(project.root, cwd)).sort((a, b) => b.root.length - a.root.length);
  if (matches.length > 1 && matches[0]!.root === matches[1]!.root && matches[0]!.id !== matches[1]!.id) {
    throw new Error("Codex project membership is ambiguous; assign this chat to its project in Codex");
  }
  return matches[0];
}

export function readCodexChatProject(path: string, threadId: string, cwd: string): CodexChatProject | undefined {
  return codexChatProject(existsSync(path) ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) : {}, threadId, cwd);
}

export function projectSetupQuestion(project: CodexChatProject): string {
  return `Для проекта Codex «${project.name}» (${project.root}) нужен проект ChatGPT. Создай его в ChatGPT или выбери существующий и пришли ответом только его ссылку вида https://chatgpt.com/g/g-p-…/project. Я сохраню связь и продолжу исходную задачу. До этого данные задачи не отправляются в ChatGPT.`;
}

export function projectSetupReply(text: string): string | undefined {
  const trimmed = text.trim();
  const markdown = /^\[(https:\/\/chatgpt\.com\/[^\s]+)\]\(\1\)$/.exec(trimmed);
  try { return chatGptProjectUrl(markdown?.[1] ?? trimmed); } catch { return undefined; }
}

export function readSavedChatProjects(path: string): SavedChatProject[] {
  return validateSavedChatProjects(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")).savedChatProjects);
}

export function saveChatProjectBinding(path: string, root: string, url: string): void {
  const original = readFileSync(path, "utf8");
  const config = JSON.parse(original.replace(/^\uFEFF/, ""));
  const identity = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  config.savedChatProjects = validateSavedChatProjects([
    ...validateSavedChatProjects(config.savedChatProjects).filter(item => identity(item.root) !== identity(root)), { root, url },
  ]);
  atomicWriteFile(path, (original.startsWith("\uFEFF") ? "\uFEFF" : "") + JSON.stringify(config, null, 2) + "\n");
}

export function validateSavedChatProjects(value: unknown): SavedChatProject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("savedChatProjects must be an array");
  const roots = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || typeof item.root !== "string" || !isAbsolute(item.root)
      || typeof item.url !== "string") throw new Error("Invalid savedChatProjects binding");
    const root = resolve(item.root);
    const identity = process.platform === "win32" ? root.toLowerCase() : root;
    if (roots.has(identity)) throw new Error("Duplicate savedChatProjects root");
    roots.add(identity);
    return { root, url: chatGptProjectUrl(item.url) };
  });
}

/** Only a verified native environment supplies cwd; prompt text cannot select another project's history. */
export function savedChatProjectForCwd(projects: SavedChatProject[], cwd: string): string | undefined {
  return projects.filter(project => {
    return contains(project.root, cwd);
  }).sort((a, b) => b.root.length - a.root.length)[0]?.url;
}
