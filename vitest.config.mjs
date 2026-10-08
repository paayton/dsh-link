import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    environment: "node",          // UI 测试在文件头用 @vitest-environment jsdom 单独声明
    testTimeout: 20000,
    hookTimeout: 30000,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/public/**/*.js", "dist/host/**/*.js"],
      exclude: ["dist/host/types.js", "**/*.d.ts"],
      // 门槛定在 2026-10 基线（77/63/80/77）略下方，只防回退不做追求
      thresholds: { statements: 72, branches: 55, functions: 72, lines: 72 },
    },
  },
});
