import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  symlink,
  readFile,
  readdir,
  stat,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMapping, saveOrganization } from "../src/config.ts";
import type { Config } from "../src/model.ts";

test("saving mappings preserves colliding files and symlink targets and installs private JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sereno-config-test-"));
  try {
    const path = join(directory, "config.json"),
      victim = join(directory, "victim");
    const collision = `${path}.${process.pid}.tmp`;
    await writeFile(victim, "keep me");
    for (const kind of ["symlink", "file"]) {
      if (kind === "symlink") await symlink(victim, collision);
      else await writeFile(collision, "existing temporary file");
      const config: Config = { projectRoots: [], mappings: [], sites: [] };
      await saveMapping(config, "process:123", ["/synthetic/project"], path);
      assert.equal(await readFile(victim, "utf8"), "keep me");
      assert.equal(
        await readFile(collision, "utf8"),
        kind === "symlink" ? "keep me" : "existing temporary file",
      );
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")).mappings, config.mappings);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      await rm(collision);
    }
    assert.deepEqual((await readdir(directory)).sort(), ["config.json", "victim"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("failed replacement cleans temporary files without changing in-memory mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sereno-config-test-"));
  try {
    const path = join(directory, "config.json");
    await mkdir(path);
    const config: Config = { projectRoots: [], mappings: [], sites: [] };
    await assert.rejects(saveMapping(config, "process:123", [], path));
    assert.deepEqual(config.mappings, []);
    assert.deepEqual(await readdir(directory), ["config.json"]);
    await chmod(directory, 0o770);
    await assert.rejects(
      saveMapping(config, "process:123", [], path),
      /not writable by group or others/,
    );
    assert.deepEqual(await readdir(directory), ["config.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("organization saves share exclusive temporary-file protection and preserve mappings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sereno-organization-test-"));
  try {
    const path = join(directory, "config.json"),
      victim = join(directory, "victim");
    const collision = `${path}.${process.pid}.tmp`;
    await writeFile(victim, "keep me");
    await symlink(victim, collision);
    const config: Config = {
      projectRoots: [],
      mappings: [{ resource: "process:123", projects: ["/synthetic/project"] }],
      sites: [],
    };
    const organization = { version: 1 as const, groups: [], resources: [], placements: [] };
    await saveOrganization(config, organization, path);
    assert.equal(await readFile(victim, "utf8"), "keep me");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).mappings, config.mappings);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await readdir(directory)).sort(),
      ["config.json", `config.json.${process.pid}.tmp`, "victim"].sort(),
    );
    const previous = config.organization;
    await chmod(directory, 0o770);
    await assert.rejects(
      saveOrganization(config, organization, path),
      /not writable by group or others/,
    );
    assert.equal(config.organization, previous);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
