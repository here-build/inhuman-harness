// Local-only secret, absent in production; see auth/dev.ts.
interface Env {
  DEV_AUTH_TOKEN?: string;
  /** Milliseconds the daemon room socket outlives the last browser (default 30000). Tests shorten it. */
  ROOM_GRACE_MS?: string;
  /** Milliseconds daemon room sockets outlive a lost control socket (default 60000). */
  CONTROL_GRACE_MS?: string;
}
