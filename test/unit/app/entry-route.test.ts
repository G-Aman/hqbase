import { describe, expect, it } from "vitest";

import { selectEntryRoute } from "@/entry-route";

describe("application entry route", () => {
  it("selects the dedicated device and OAuth consent entry points", () => {
    expect(selectEntryRoute("/device")).toBe("device-authorization");
    expect(selectEntryRoute("/oauth/consent")).toBe("oauth-consent");
    expect(selectEntryRoute("/mcp/consent")).toBe("oauth-consent");
  });

  it("uses the application entry point for all other paths", () => {
    expect(selectEntryRoute("/inbox")).toBe("app");
  });
});
