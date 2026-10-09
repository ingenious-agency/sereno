import { relative, isAbsolute } from "node:path";
import type { Association, Config, Project, Resource } from "./model.ts";

export function within(path: string, root: string) {
  if (!isAbsolute(path) || !isAbsolute(root)) return false;
  const r = relative(root, path);
  return r === "" || (!r.startsWith("../") && r !== ".." && !isAbsolute(r));
}
export function associate(resources: Resource[], projects: Project[], config: Config): Resource[] {
  const output = resources.map((resource) => {
    const associations: Association[] = [];
    const override = config.mappings.find((m) => m.resource === resource.id);
    if (override)
      for (const project of override.projects)
        associations.push({
          ...override.relationships?.find((r) => r.project === project),
          project,
          state: "Assigned",
          reason: "Explicit configuration override",
        });
    else
      for (const project of projects) {
        const path = resource.paths.find((path) =>
          [project.path, ...project.worktrees].some((root) => within(path, root)),
        );
        if (path)
          associations.push({
            project: project.id,
            state: "Detected",
            reason: `Working directory / Git worktree: ${path}`,
          });
        else if (
          [resource.name, resource.metadata["service"], resource.metadata["compose.project"]]
            .filter(Boolean)
            .some((name) => name === project.name || name.startsWith(project.name + "-"))
        ) {
          associations.push({
            project: project.id,
            state: "Suggested",
            reason: "Name or Kamal service label resembles project; assignment required",
          });
        }
      }
    return { ...resource, associations };
  });
  // Propagate only concrete links (PID/cgroup/backend), never fuzzy names.
  for (let pass = 0; pass < 3; pass++)
    for (const r of output) {
      if (config.mappings.some((m) => m.resource === r.id)) continue;
      for (const id of r.related)
        for (const a of output.find(
          (other) => other.id === id && !(r.kind === "process" && other.kind === "service"),
        )?.associations ?? []) {
          if (
            a.state === "Suggested" ||
            r.associations.some((x) => x.project === a.project && x.state !== "Suggested")
          )
            continue;
          r.associations = r.associations.filter((x) => x.project !== a.project);
          r.associations.push({ ...a, state: "Detected", reason: `Concrete resource link: ${id}` });
        }
    }
  return output;
}
export function uniqueResources(resources: Resource[], projects: string[]) {
  return [
    ...new Map(
      resources
        .filter((r) =>
          r.associations.some((a) => a.state !== "Suggested" && projects.includes(a.project)),
        )
        .map((r) => [r.id, r]),
    ).values(),
  ];
}
