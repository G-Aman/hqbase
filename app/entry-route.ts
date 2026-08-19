export type EntryRoute = "app" | "device-authorization" | "oauth-consent";

export function selectEntryRoute(pathname: string): EntryRoute {
  switch (pathname) {
    case "/device":
      return "device-authorization";
    case "/oauth/consent":
    case "/mcp/consent":
      return "oauth-consent";
    default:
      return "app";
  }
}
