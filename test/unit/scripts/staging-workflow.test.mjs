import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/staging-e2e.yml", import.meta.url),
  "utf8"
);

describe("staging workflow lifecycle record", () => {
  it("records the reviewed Worker deploy before cleanup", () => {
    const deploy = workflow.indexOf("pnpm exec wrangler deploy --config");
    const checkpoint = workflow.indexOf("manifest.worker.deployed = true");
    const cleanup = workflow.indexOf('pnpm hqbase destroy --name "$DEPLOYMENT_NAME"');

    expect(deploy).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(deploy);
    expect(cleanup).toBeGreaterThan(checkpoint);
  });
});
