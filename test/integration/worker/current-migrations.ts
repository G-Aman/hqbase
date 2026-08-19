import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";

type MigrationTestEnv = Env & {
  TEST_MIGRATIONS: D1Migration[];
};

export async function applyCurrentMigrations(): Promise<void> {
  const testEnv = env as MigrationTestEnv;
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
}
