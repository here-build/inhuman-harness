/**
 * WebSocket close codes the relay speaks. 4xxx is application space; browsers see these in
 * `CloseEvent.code`, so the web app can tell "machine is off" from "network blip".
 */

/** Browser room: the machine has no control socket (daemon offline), or lost it and did not return in time. */
export const CLOSE_OFFLINE = 4503;
/** Browser room: the daemon's room socket closed with a code that is not its own to define; redial to reopen it. */
export const CLOSE_ROOM_CLOSED = 4504;
/** Browser room: the room path is not one the daemon serves. */
export const CLOSE_BAD_ROOM = 4400;
/** A socket this relay closed because a newer one took its place (control, or daemon room). */
export const CLOSE_REPLACED = 1012;

/** A connector reports a refused upgrade as 4000 + HTTP status (4404 unknown session, 4400 missing path, 4500 route failed). */
export const isConnectorCode = (code: number): boolean => code >= 4400 && code <= 4599;
