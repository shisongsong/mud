export function validateModuleGraph(modules) {
  const names = new Set(modules.map((module) => module.name));
  const violations = [];

  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (!names.has(dependency.name)) {
        violations.push(
          `${module.name} depends on unknown module ${dependency.name}`,
        );
      } else if (dependency.name !== module.name && !dependency.publicEntry) {
        violations.push(
          `${module.name} imports internal implementation of ${dependency.name}`,
        );
      }
    }
  }

  const state = new Map();
  const stack = [];
  const reportedCycles = new Set();

  function visit(name) {
    state.set(name, 1);
    stack.push(name);

    const module = modules.find((candidate) => candidate.name === name);
    for (const dependency of module?.dependencies ?? []) {
      if (!names.has(dependency.name)) continue;

      if (state.get(dependency.name) === 1) {
        const start = stack.indexOf(dependency.name);
        const cycle = [...stack.slice(start), dependency.name];
        const canonical = [...cycle.slice(0, -1)].sort().join(" -> ");
        if (!reportedCycles.has(canonical)) {
          reportedCycles.add(canonical);
          violations.push(`module dependency cycle: ${cycle.join(" -> ")}`);
        }
      } else if (state.get(dependency.name) !== 2) {
        visit(dependency.name);
      }
    }

    stack.pop();
    state.set(name, 2);
  }

  for (const name of names) {
    if (!state.has(name)) visit(name);
  }

  return violations;
}
