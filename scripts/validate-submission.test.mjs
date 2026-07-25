// Subprocess-level tests for validate-submission.mjs's --changed handling —
// this is exactly the branching that shipped a real bug once already (a
// repo-maintenance PR touching apps/ alongside other files was hard-rejected
// as "not a pure submission"), so it's tested by actually invoking the CLI,
// not just the library function it's built on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repoRoot, "scripts", "validate-submission.mjs");
const EXAMPLE_RECORDING = readFileSync(
  join(repoRoot, "scripts", "__fixtures__", "example-recording.json"),
  "utf8",
);

// A throwaway repo root with its own apps/ and the schema/ dir the CLI's
// (relative-to-script, not relative-to-cwd) imports still need to find —
// schema/ is imported by module path, so nothing needs copying there.
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "validate-cli-test-"));
  mkdirSync(join(root, "apps", "piercypixel_example_app"), { recursive: true });
  writeFileSync(join(root, "apps", "piercypixel_example_app", "recording.json"), EXAMPLE_RECORDING);
  return root;
}

function runCli(cwd, changedPaths, extraArgs = []) {
  const changedFile = join(cwd, "changed.txt");
  writeFileSync(changedFile, changedPaths.join("\n"));
  try {
    const stdout = execFileSync("node", [CLI, "--changed", changedFile, ...extraArgs], {
      cwd,
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("a pure submission (nothing else touched) is strictly validated and passes", () => {
  const cwd = tempRepo();
  const result = runCli(cwd, [
    "apps/piercypixel_example_app/recording.json",
    "apps/piercypixel_example_app/thumbnail.png",
  ]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /valid — "Example App"/);
});

test("a maintenance PR touching only unrelated files passes trivially — nothing to validate", () => {
  const cwd = tempRepo();
  const result = runCli(cwd, ["README.md", ".github/workflows/validate.yml"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /isn't shaped like a submission/);
});

test("a PR that ALSO touches unrelated files still strictly validates the apps/ submission it carries", () => {
  const cwd = tempRepo();
  const result = runCli(cwd, ["README.md", "CONTRIBUTING.md", "apps/piercypixel_example_app/recording.json"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /valid — "Example App"/);
  assert.match(result.stdout, /also touches files unrelated/);
});

test("a submission PR that ALSO edits the gallery's machinery hard-fails", () => {
  // The dangerous shape for an automated approver: a valid-looking bundle with
  // a change to the validator/workflow/lockfile riding along in the same PR.
  // Previously this passed — the note about "unrelated" files was the only
  // trace, and the check still went green.
  for (const machinery of [
    ".github/workflows/validate.yml",
    "scripts/validate-submission.mjs",
    "schema/app-recording-bundle.mjs",
    "package-lock.json",
  ]) {
    const result = runCli(tempRepo(), ["apps/piercypixel_example_app/recording.json", machinery]);
    assert.equal(result.code, 1, `${machinery} should fail the check`);
    assert.match(result.stderr, /may not change the gallery's own machinery/);
    assert.ok(result.stderr.includes(machinery), `${machinery} should be named in the failure`);
  }
});

test("--apps-dir reads submissions from a separate tree, so CI can run the base validator against PR data", () => {
  // The structural half of the fix: in CI the script runs from the base
  // checkout while the bundle it reads comes from the PR checkout.
  const cwd = tempRepo();
  const dataRoot = mkdtempSync(join(tmpdir(), "apps-data-"));
  cpSync(join(cwd, "apps"), join(dataRoot, "apps"), { recursive: true });
  rmSync(join(cwd, "apps"), { recursive: true, force: true });

  // Without the flag the submission isn't where the script is running from.
  const missing = runCli(cwd, ["apps/piercypixel_example_app/recording.json"]);
  assert.equal(missing.code, 1);

  const result = runCli(cwd, ["apps/piercypixel_example_app/recording.json"], ["--apps-dir", join(dataRoot, "apps")]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /valid — "Example App"/);
});

test("a file smuggled into the submission's own apps/ folder always hard-fails, even alongside unrelated changes", () => {
  const cwd = tempRepo();
  const result = runCli(cwd, [
    "README.md",
    "apps/piercypixel_example_app/recording.json",
    "apps/piercypixel_example_app/evil.sh",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /may only add files under/);
});

test("touching two different submission folders in one PR hard-fails", () => {
  const cwd = tempRepo();
  mkdirSync(join(cwd, "apps", "someone_else_app"), { recursive: true });
  writeFileSync(join(cwd, "apps", "someone_else_app", "recording.json"), EXAMPLE_RECORDING);
  const result = runCli(cwd, [
    "apps/piercypixel_example_app/recording.json",
    "apps/someone_else_app/recording.json",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exactly one submission folder/);
});

test("the folder's login must match the PR author", () => {
  const cwd = tempRepo();
  const result = runCli(cwd, ["apps/piercypixel_example_app/recording.json"], ["--author", "someone-else"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not match the PR author/);
});
