import { describe, expect, it } from "vitest";
import { spawnProcess } from "../../../scripts/shell.mjs";

// The child prints back exactly what it received, so the assertions compare real argv rather
// than an intermediate quoting representation.
// `--` stops Node from claiming arguments such as `--config` as its own options.
const echoArgv = ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--"];

function childArgv(args) {
  const result = spawnProcess(process.execPath, [...echoArgv, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`child exited with ${result.status}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

describe("child process arguments", () => {
  it("delivers ordinary arguments unchanged", () => {
    const args = ["exec", "wrangler", "d1", "create", "hqbase-qa"];

    expect(childArgv(args)).toEqual(args);
  });

  it("delivers arguments containing whitespace unchanged", () => {
    const args = ["--config", "C:\\Program Files\\repo\\wrangler.jsonc"];

    expect(childArgv(args)).toEqual(args);
  });

  it("delivers arguments containing shell metacharacters unchanged", () => {
    const args = ["a&b", "c|d", "e>f", "g^h", "(i)"];

    expect(childArgv(args)).toEqual(args);
  });

  it("does not expand environment variable syntax inside arguments", () => {
    const args = ["literal %USERNAME% here", "$HOME stays literal"];

    expect(childArgv(args)).toEqual(args);
  });

  it("delivers SQL containing quotes and wildcards unchanged", () => {
    const args = [
      "--command",
      "UPDATE release_state SET installed_version = '1.0.1' WHERE singleton = 1",
      "--command",
      "SELECT * FROM mailboxes WHERE address LIKE '%@example.com'"
    ];

    expect(childArgv(args)).toEqual(args);
  });
});
