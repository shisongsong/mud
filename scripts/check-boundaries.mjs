import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateModuleGraph } from "./boundary-rules.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(repositoryRoot, "apps", "api", "src");
const modulesRoot = path.join(sourceRoot, "modules");
const importPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{},\s]+?\s+from\s+)?["']([^"']+)["']/g;

async function collectFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

const files = await collectFiles(modulesRoot);
const modules = new Map();

for (const file of files) {
  const relativeFile = path.relative(modulesRoot, file);
  const sourceModule = relativeFile.split(path.sep)[0];
  if (!sourceModule) continue;

  const source = await readFile(file, "utf8");
  const dependencies = modules.get(sourceModule) ?? [];
  importPattern.lastIndex = 0;

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;

    const targetPath = path.resolve(path.dirname(file), specifier);
    const relativeTarget = path.relative(modulesRoot, targetPath);
    const targetParts = relativeTarget.split(path.sep);
    if (targetParts.length < 2 || targetParts[0] === "..") continue;

    const targetModule = targetParts[0];
    if (targetModule === sourceModule) continue;

    const publicEntry =
      targetParts.length === 2 &&
      /^(?:public|index)(?:\.ts|\.js)?$/.test(targetParts[1]);
    dependencies.push({ name: targetModule, publicEntry });
  }

  modules.set(sourceModule, dependencies);
}

const platformFiles = await collectFiles(path.join(sourceRoot, "platform"));
for (const file of platformFiles) {
  const relativeFile = path.relative(sourceRoot, file);
  const relativeParts = relativeFile.split(path.sep);
  const sourceModule = relativeParts.slice(0, 2).join("/");
  if (relativeParts.length < 3) continue;

  const source = await readFile(file, "utf8");
  const dependencies = modules.get(sourceModule) ?? [];
  importPattern.lastIndex = 0;

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;

    const targetPath = path.resolve(path.dirname(file), specifier);
    const relativeTarget = path.relative(sourceRoot, targetPath);
    const targetParts = relativeTarget.split(path.sep);
    if (targetParts.length < 3 || targetParts[0] !== "modules") continue;

    const targetModule = targetParts[1];
    if (!targetModule || targetModule === sourceModule) continue;
    const publicEntry =
      targetParts.length === 3 &&
      /^(?:public|index)(?:\.ts|\.js)?$/.test(targetParts[2] ?? "");
    dependencies.push({ name: targetModule, publicEntry });
  }

  modules.set(sourceModule, dependencies);
}

const violations = validateModuleGraph(
  [...modules].map(([name, dependencies]) => ({ name, dependencies })),
);

if (violations.length > 0) {
  console.error(violations.map((violation) => `- ${violation}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Module boundary check passed (${modules.size} module(s)).`);
}
