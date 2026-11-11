import { DocumentContainer, Model, model } from "@inhuman.tools/model";

@model("harness:peer:doc-root")
export class DocRoot extends Model {}

export type Doc = DocumentContainer<any, any>;
export { DocumentContainer } from "@inhuman.tools/model";

export type CreateDocOptions = {
  readonly guid?: string;
  readonly revision?: number;
  readonly clientId?: number;
  readonly meta?: Record<string, Record<string, unknown>>;
};

export function createDoc(options?: CreateDocOptions): DocumentContainer<DocRoot> {
  const root = new DocRoot();
  return new DocumentContainer<DocRoot>(root, {
    guid: options?.guid,
    revision: options?.revision,
    clientId: options?.clientId,
    meta: options?.meta,
  });
}
