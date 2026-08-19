import { hashOAuthToken } from "../../../worker/auth/oauth-token";

export async function tokenRow(
  db: D1Database,
  id: string,
  bearer: string,
  clientId: string,
  sessionId: string,
  tokenUserId: string,
  expiresAt: string,
  tokenScopes: string[],
  resource: string,
  revoked: string | null = null
) {
  return db
    .prepare(
      `INSERT INTO oauthAccessToken
     (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes, resources, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      await hashOAuthToken(bearer.slice("hqb_access_".length)),
      clientId,
      sessionId,
      tokenUserId,
      expiresAt,
      new Date().toISOString(),
      JSON.stringify(tokenScopes),
      JSON.stringify([resource]),
      revoked
    );
}
