/**
 * Copied from plexus/packages/plexus-do/src/constants.ts (same author; the owner
 * relicenses it MIT here). Only the y-websocket message types are kept.
 */

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
/** y-websocket `messageQueryAwareness`. The daemon sends it as a keepalive and answers it with a snapshot. */
export const MESSAGE_QUERY_AWARENESS = 3;
