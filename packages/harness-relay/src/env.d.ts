// Local-only secret, absent in production; see auth/dev.ts.
interface Env {
  DEV_AUTH_TOKEN?: string;
}
