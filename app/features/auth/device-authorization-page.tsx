import * as React from "react";

import { Toaster } from "@/components/ui/sonner";
import { getCurrentUser } from "@/features/auth/api";
import {
  DeviceAuthorizationFailure,
  DeviceAuthorizationResult,
  DeviceAuthorizationReview,
  DeviceCodeEntry,
  FullScreenStatus
} from "@/features/auth/device-authorization-view";
import { LoginPage } from "@/features/auth/login-page";
import type { CurrentUser } from "@/features/auth/types";

type DeviceVerification = {
  user_code: string;
  status: "pending" | "approved" | "denied";
  client_id?: string;
  scope?: string;
  resource?: string | string[];
};

type OAuthClient = {
  client_id?: string;
  client_name?: string;
  name?: string;
};

export function DeviceAuthorizationPage(): React.ReactElement {
  const initialCode = normalizeUserCode(
    new URLSearchParams(window.location.search).get("user_code")
  );
  const [userCode, setUserCode] = React.useState(initialCode);
  const [inputCode, setInputCode] = React.useState(initialCode);
  const [user, setUser] = React.useState<CurrentUser | null>(null);
  const [identityChecked, setIdentityChecked] = React.useState(false);
  const [verification, setVerification] = React.useState<DeviceVerification | null>(null);
  const [client, setClient] = React.useState<OAuthClient | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [pending, setPending] = React.useState<"allow" | "deny" | null>(null);

  const loadIdentity = React.useCallback(async () => {
    try {
      setUser(await getCurrentUser());
    } catch {
      setUser(null);
    } finally {
      setIdentityChecked(true);
    }
  }, []);

  React.useEffect(() => {
    void loadIdentity();
  }, [loadIdentity]);

  React.useEffect(() => {
    if (!user || !userCode) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setVerification(null);
    setClient(null);

    void fetch(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, {
      credentials: "include"
    })
      .then(async (response) => {
        const payload = await response
          .clone()
          .json<DeviceVerification & { error_description?: unknown }>()
          .catch(() => null);
        if (!response.ok || !payload) {
          throw new Error(
            typeof payload?.error_description === "string"
              ? payload.error_description
              : "This device authorization request could not be verified."
          );
        }
        if (cancelled) return;
        setVerification(payload);
        if (!payload.client_id) {
          throw new Error("The requesting OAuth client could not be verified.");
        }
        const clientResponse = await fetch(
          `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(payload.client_id)}`,
          { credentials: "include" }
        );
        if (!clientResponse.ok)
          throw new Error("The requesting OAuth client could not be verified.");
        const nextClient = (await clientResponse.json()) as OAuthClient;
        if (!cancelled) setClient(nextClient);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "This device authorization request could not be verified."
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, userCode]);

  function submitCode(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizeUserCode(inputCode);
    if (!normalized) {
      setError("Enter the code shown by the agent or client.");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("user_code", normalized);
    window.history.replaceState(null, "", url);
    setInputCode(normalized);
    setUserCode(normalized);
    setError(null);
  }

  function resetCode(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete("user_code");
    window.history.replaceState(null, "", url);
    setUserCode("");
    setInputCode("");
    setVerification(null);
    setClient(null);
    setError(null);
  }

  async function decide(accept: boolean): Promise<void> {
    setPending(accept ? "allow" : "deny");
    setError(null);
    try {
      const response = await fetch(accept ? "/api/auth/device/approve" : "/api/auth/device/deny", {
        body: JSON.stringify({ userCode }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const payload = await response
        .clone()
        .json<{ error_description?: unknown }>()
        .catch(() => null);
      if (!response.ok) {
        throw new Error(
          typeof payload?.error_description === "string"
            ? payload.error_description
            : "The authorization decision could not be saved."
        );
      }
      setVerification((current) =>
        current ? { ...current, status: accept ? "approved" : "denied" } : current
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The authorization decision could not be saved."
      );
    } finally {
      setPending(null);
    }
  }

  if (!userCode) {
    return (
      <>
        <DeviceCodeEntry
          error={error}
          inputCode={inputCode}
          onInputCodeChange={setInputCode}
          onSubmit={submitCode}
        />
        <Toaster />
      </>
    );
  }

  if (!identityChecked) return <FullScreenStatus label="Checking your HQBase session" />;
  if (!user) {
    return (
      <>
        <LoginPage onLogin={() => void loadIdentity()} />
        <Toaster />
      </>
    );
  }

  if (loading && !verification) return <FullScreenStatus label="Checking the device code" />;

  if (error && !verification) {
    return (
      <>
        <DeviceAuthorizationFailure error={error} onRetry={resetCode} />
        <Toaster />
      </>
    );
  }

  if (verification?.status === "approved" || verification?.status === "denied") {
    return (
      <>
        <DeviceAuthorizationResult approved={verification.status === "approved"} />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <DeviceAuthorizationReview
        clientName={client?.client_name ?? client?.name ?? "OAuth client"}
        error={error}
        identity={`${user.name} (${user.email})`}
        onAllow={() => void decide(true)}
        onDeny={() => void decide(false)}
        pending={pending}
        resource={resourceLabel(verification?.resource)}
        scopes={parseScopes(verification?.scope)}
        userCode={formatUserCode(userCode)}
        verified={Boolean(verification && client)}
      />
      <Toaster />
    </>
  );
}

function normalizeUserCode(value: string | null): string {
  return value?.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() ?? "";
}

function formatUserCode(value: string): string {
  return value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4)}` : value;
}

function parseScopes(value: string | undefined): string[] {
  return value?.split(/\s+/).filter(Boolean) ?? [];
}

function resourceLabel(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "No resource was requested";
}
