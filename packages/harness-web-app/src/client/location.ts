/**
 * Where the app is served from. Local: the loopback origin, rooms at its root.
 * Remote: the relay, under `/m/<machineId>/app/`, rooms under `/m/<machineId>/room`.
 * index.html repeats the path test to set `<base>` before any asset loads.
 */
export type AppLocation = {
  readonly remote: boolean;
  /** Room socket origin, as `WebsocketProvider` takes it: it appends `/<room>?<params>`. */
  readonly roomOrigin: string;
  /** Where plain HTTP calls to the daemon (`/sessions/...`) are rooted, without a trailing slash. */
  readonly httpBase: string;
  /** Router base path; `undefined` at the root. */
  readonly basepath: string | undefined;
  /** URL for a project file. */
  fileUrl(absolutePath: string): string;
};

const REMOTE_PATH = /^\/m\/([\w-]{1,64})\/app(?:\/|$)/;

export function appLocation(location: Pick<Location, "pathname" | "search" | "host" | "protocol">): AppLocation {
  const machine = REMOTE_PATH.exec(location.pathname)?.[1];
  if (machine != null) {
    const secure = location.protocol === "https:";
    const root = `/m/${machine}`;
    return {
      remote: true,
      roomOrigin: `${secure ? "wss" : "ws"}://${location.host}${root}/room`,
      httpBase: `${secure ? "https" : "http"}://${location.host}${root}`,
      basepath: `${root}/app`,
      fileUrl: (path) => `${root}/file?path=${encodeURIComponent(path)}`,
    };
  }
  const dial = new URLSearchParams(location.search).get("dial");
  const roomOrigin = dial != null && dial !== "" ? dial : `ws://${location.host}`;
  return {
    remote: false,
    roomOrigin,
    httpBase: roomOrigin.replace(/^ws/, "http"),
    basepath: undefined,
    fileUrl: (path) => `/file?path=${encodeURIComponent(path)}`,
  };
}
