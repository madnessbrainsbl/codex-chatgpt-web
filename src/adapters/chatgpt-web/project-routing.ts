import { isAbsolute, relative, resolve } from "node:path";
import { chatGptProjectUrl } from "../../chatgpt-session";

export interface SavedChatProject { root: string; url: string }

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
    const rel = relative(project.root, resolve(cwd));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }).sort((a, b) => b.root.length - a.root.length)[0]?.url;
}
