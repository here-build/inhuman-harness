/**
 * Path is the project identity. The Y.Doc guid is minted (nanoid), not
 * hashed from the path — a hash pulled `node:crypto` and made the
 * browser recompute an id the room already has (`?path=`).
 */
import { Plexus, type AwarenessShape, type PlexusOptions } from "@here.build/plexus";
import { nanoid } from "nanoid";
import * as Y from "yjs";

import { ProjectRoot } from "./ProjectRoot.js";

export const PROJECT_DOC_KIND = "harness:project";

export function mintProjectDocGuid(): string {
  return `${PROJECT_DOC_KIND}:${nanoid()}`;
}

export class ProjectPlexus extends Plexus<ProjectRoot, AwarenessShape> {
  static connect(doc: Y.Doc, options?: PlexusOptions): ProjectPlexus {
    return super.connect(doc, options) as ProjectPlexus;
  }

  static create(path: string, doc?: Y.Doc): ProjectPlexus {
    const guid = doc?.guid ?? mintProjectDocGuid();
    return super.bootstrap(new ProjectRoot({ path }), guid, doc ?? new Y.Doc({ guid })) as ProjectPlexus;
  }
}
