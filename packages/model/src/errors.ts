export class SchemaAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaAuditError";
  }
}

export class BrokenReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokenReferenceError";
  }
}
