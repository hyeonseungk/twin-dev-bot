import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/types/**",
        "src/server.ts",
        "src/cli.ts",
        "src/config.ts",
        "src/handlers/index.ts",
      ],
    },
    restoreMocks: true,
    clearMocks: true,
  },
});
