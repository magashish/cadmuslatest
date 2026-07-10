import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["dist/**", "node_modules/**"],
    env: {
      DATABASE_URL: "postgresql://cadmus:cadmus@localhost:5432/cadmus_test",
    },
  },
});
