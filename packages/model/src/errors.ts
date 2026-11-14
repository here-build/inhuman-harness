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

export class ReadOnlyDocumentError extends Error {
  constructor(message = "Cannot write to a read-only document.") {
    super(message);
    this.name = "ReadOnlyDocumentError";
  }
}
