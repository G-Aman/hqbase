PRAGMA foreign_keys = ON;

ALTER TABLE oauthClient ADD COLUMN clientDiscoveryId TEXT;
ALTER TABLE oauthClient ADD COLUMN clientCredentialsScopes TEXT;
ALTER TABLE oauthClient ADD COLUMN applicationType TEXT;

DELETE FROM oauthClientResource
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM oauthClientResource
  GROUP BY clientId, resourceId
);

CREATE UNIQUE INDEX oauthClientResource_clientId_resourceId_uidx
ON oauthClientResource(clientId, resourceId);

CREATE TABLE deviceCode (
  id TEXT PRIMARY KEY NOT NULL,
  deviceCode TEXT NOT NULL UNIQUE,
  userCode TEXT NOT NULL UNIQUE,
  userId TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  expiresAt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  lastPolledAt TEXT,
  pollingInterval INTEGER,
  clientId TEXT REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  scope TEXT,
  resources TEXT,
  oauthClientId TEXT REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  sessionId TEXT REFERENCES "session"(id) ON DELETE SET NULL
);

CREATE INDEX deviceCode_userId_idx ON deviceCode(userId);
CREATE INDEX deviceCode_clientId_idx ON deviceCode(clientId);
CREATE INDEX deviceCode_oauthClientId_idx ON deviceCode(oauthClientId);
CREATE INDEX deviceCode_expiresAt_idx ON deviceCode(expiresAt);
