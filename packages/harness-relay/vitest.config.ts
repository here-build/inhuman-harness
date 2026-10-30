import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with real Durable Objects (Miniflare), against the Worker's own config.
// Placeholder secrets; tests never reach WorkOS.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          WORKOS_API_KEY: "sk_test",
          WORKOS_COOKIE_PASSWORD: "test-cookie-password-0123456789abcdef",
        },
      },
    }),
  ],
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
