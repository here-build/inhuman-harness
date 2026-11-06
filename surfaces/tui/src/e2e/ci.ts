import { env } from "node:process";

/**
 * True inside CI runners (GitHub Actions, generic CI=true).
 *
 * Used ONLY to skip the visual terminal-zoo suites — those need real mac GUI
 * terminals with Accessibility + Screen Recording permission, which CI never
 * has. Per the loud-skip rule (tests.md), `describe.skipIf(isCI())` is the
 * sanctioned gate for that case and nothing else: a test that fails because
 * of missing machinery must stay loud, not be hidden behind `isCI()`.
 */
export function isCI(): boolean {
  return env.CI === "true" || env.GITHUB_ACTIONS === "true";
}
