import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { hashPassword as hashBetterAuthPassword } from "better-auth/crypto";

import { buildSeedSql } from "./local-seed-fixture.mjs";
import { spawnProcess } from "./shell.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerEmail = "owner@hqbase.test";

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}

export { buildSeedSql } from "./local-seed-fixture.mjs";

export async function main() {
  const passwordHash = await hashSeedPassword(seedPassword());
  const seedDirectory = mkdtempSync(path.join(tmpdir(), "hqbase-local-seed-"));
  const sqlPath = path.join(seedDirectory, "seed.sql");

  try {
    writeFileSync(sqlPath, buildSeedSql(passwordHash), { encoding: "utf8", mode: 0o600 });
    const result = spawnProcess(
      "wrangler",
      ["d1", "execute", "DB", "--local", "--yes", "--file", sqlPath],
      { cwd: rootDir, stdio: "inherit" }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Local D1 seed failed with exit code ${result.status ?? "unknown"}.`);
    }
    process.stdout.write(
      `Seeded local HQBase data. Sign in as ${ownerEmail} using HQBASE_LOCAL_SEED_PASSWORD.\n`
    );
  } finally {
    rmSync(seedDirectory, { force: true, recursive: true });
  }
}

export function hashSeedPassword(password) {
  return hashBetterAuthPassword(password);
}

function seedPassword() {
  if (process.env.HQBASE_LOCAL_SEED_PASSWORD !== undefined) {
    return validatePassword(process.env.HQBASE_LOCAL_SEED_PASSWORD);
  }

  const devVarsPath = path.join(rootDir, ".dev.vars");
  if (existsSync(devVarsPath)) {
    let devVars;
    try {
      devVars = parseEnv(readFileSync(devVarsPath, "utf8"));
    } catch {
      throw new Error("Could not parse .dev.vars while reading HQBASE_LOCAL_SEED_PASSWORD.");
    }
    if (devVars.HQBASE_LOCAL_SEED_PASSWORD !== undefined) {
      return validatePassword(devVars.HQBASE_LOCAL_SEED_PASSWORD);
    }
  }

  throw new Error(
    "Set HQBASE_LOCAL_SEED_PASSWORD in .dev.vars or the environment before seeding local data."
  );
}

function validatePassword(password) {
  if (password.length < 8 || password.length > 128) {
    throw new Error("HQBASE_LOCAL_SEED_PASSWORD must be between 8 and 128 characters.");
  }
  return password;
}
