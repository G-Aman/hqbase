import { spawnProcess } from "../shell.mjs";

function commandEnvironment() {
  return { ...process.env, CI: process.env.CI ?? "true" };
}

function assertSucceeded(result, command, args) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // A missing status means the child never reported an exit code, so the reason is only in
    // `result.error` when one is present.
    throw new Error(
      `Command failed (${result.status ?? "no exit code"}): ${[command, ...args].join(" ")}`
    );
  }
}

export function run(command, args, cwd) {
  const result = spawnProcess(command, args, {
    cwd,
    env: commandEnvironment(),
    stdio: "inherit"
  });
  assertSucceeded(result, command, args);
}

export function capture(command, args, cwd) {
  const result = spawnProcess(command, args, {
    cwd,
    env: commandEnvironment(),
    encoding: "utf8"
  });
  assertSucceeded(result, command, args);
  return result.stdout;
}

export function attemptRun(command, args, cwd) {
  return spawnProcess(command, args, {
    cwd,
    env: commandEnvironment(),
    encoding: "utf8"
  });
}

export function emitCommandOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
