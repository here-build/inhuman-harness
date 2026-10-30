import { realpathSync } from "node:fs";

import { fail } from "@inhuman.tools/harness-diagnostics";
import { observable } from "mobx";

import { HTTPServer } from "./HTTPServer.js";
import { KernelDaemon } from "../kernel/KernelDaemon.js";
import { remoteLoggedIn } from "../kernel/remote-access.js";
import { ProjectDaemon } from "../project/ProjectDaemon.js";
import type { SessionDaemon } from "../session/SessionDaemon.js";

export class HarnessDaemon implements AsyncDisposable {
  readonly server: HTTPServer = new HTTPServer(this);
  @observable.ref accessor kernelHost: KernelDaemon | null = null;
  @observable.shallow accessor projects: Record<string, ProjectDaemon> = {};

  constructor(readonly root: string) {}

  async listen(): Promise<void> {
    await this.server.listen();
    // The remote connector lives in the kernel, which otherwise boots on the first client.
    if (remoteLoggedIn(this.root)) {
      this.kernel().catch((error: unknown) => fail("remote boot", error));
    }
  }

  /** A rejected boot or load is evicted, so the next call tries again. */
  async kernel(): Promise<KernelDaemon> {
    const kernel = (this.kernelHost ??= new KernelDaemon(this.root));
    try {
      await kernel.ready;
    } catch (error) {
      if (this.kernelHost === kernel) this.kernelHost = null;
      throw error;
    }
    return kernel;
  }

  async project(workspacePath: string): Promise<ProjectDaemon> {
    const kernel = await this.kernel();
    const path = realpathSync(workspacePath);
    const project = (this.projects[path] ??= kernel.project(path));
    try {
      await project.ready;
    } catch (error) {
      if (this.projects[path] === project) delete this.projects[path];
      throw error;
    }
    return project;
  }

  /** Restore by id. Missing id is undefined — does not mint. */
  async attachSession(sessionId: string): Promise<SessionDaemon | undefined> {
    const kernel = await this.kernel();
    return kernel.attachSession(sessionId);
  }

  /** The kernel owns every project here; its dispose parks, persists, and disposes them. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.server[Symbol.asyncDispose]();
    await this.kernelHost?.[Symbol.asyncDispose]();
    this.projects = {};
    this.kernelHost = null;
  }
}
