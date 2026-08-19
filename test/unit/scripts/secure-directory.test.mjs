import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRestrictedDirectory,
  currentUserSid,
  foreignTrustees
} from "../../../scripts/secure-directory.mjs";

const isWindows = process.platform === "win32";
const EVERYONE_SID = "S-1-1-0";

// Loosening the directory has to be expressed differently per platform: chmod widens the mode on
// POSIX, while on Windows the equivalent is handing an unrelated principal access.
function grantAccessToEveryone(directory) {
  spawnSync("icacls", [directory, "/grant", `*${EVERYONE_SID}:(OI)(CI)F`], { encoding: "utf8" });
}

const loosen = isWindows ? grantAccessToEveryone : (directory) => chmodSync(directory, 0o755);

describe("restricted directory", () => {
  it("leaves no other account with access", () => {
    const directory = createRestrictedDirectory("hqbase-secure-test-");

    try {
      if (isWindows) {
        expect(foreignTrustees(directory)).toEqual([]);
      } else {
        expect(statSync(directory).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(isWindows)("reports an unrelated account as having access", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "hqbase-secure-foreign-"));

    try {
      grantAccessToEveryone(directory);

      expect(foreignTrustees(directory)).not.toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(isWindows)("identifies the account by SID rather than by name", () => {
    expect(currentUserSid()).toMatch(/^S-1-[\d-]+$/);
  });

  it("refuses to hand back a directory it could not restrict", () => {
    expect(() => createRestrictedDirectory("hqbase-secure-test-", { restrict: loosen })).toThrow(
      "could not be restricted"
    );
  });
});
