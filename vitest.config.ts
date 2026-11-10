import { configDefaults, defineConfig } from "vitest/config";

// Pruebas con PostgreSQL en memoria (PGlite): aplican migraciones enteras
// y, con toda la suite en paralelo (CI corre `npm test`), tardan mucho más
// que los 5 s por defecto. Van en su propio proyecto con más tiempo.
const DATABASE_TESTS = ["src/**/*.database.test.ts", "src/**/database.test.ts"];

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: [...configDefaults.exclude, ...DATABASE_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "database",
          include: DATABASE_TESTS,
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Cada archivo arranca su propio Postgres en memoria (PGlite):
          // en paralelo compiten por CPU y a veces se pasan del tiempo.
          fileParallelism: false,
        },
      },
    ],
  },
});
