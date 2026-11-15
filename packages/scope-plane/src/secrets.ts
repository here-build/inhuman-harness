export type EncryptedSecretRecord = {
  readonly tenantId: string;
  readonly kernelId: string;
  readonly connectionId: string;
  readonly kid: string;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly updatedAtMs: number;
};

export interface SecretsStoreBackend extends Disposable {
  getRecord(tenantId: string, kernelId: string, connectionId: string): EncryptedSecretRecord | undefined;
  putRecord(record: EncryptedSecretRecord): void;
  deleteRecord(tenantId: string, kernelId: string, connectionId: string): void;
  listConnectionIds(tenantId: string, kernelId: string): string[];
}

export interface AsyncSecretsStoreBackend extends AsyncDisposable {
  getRecord(tenantId: string, kernelId: string, connectionId: string): Promise<EncryptedSecretRecord | undefined>;
  listRecords?(tenantId: string, kernelId: string): Promise<readonly EncryptedSecretRecord[]>;
  putRecord(record: EncryptedSecretRecord): Promise<void>;
  deleteRecord(tenantId: string, kernelId: string, connectionId: string): Promise<void>;
  listConnectionIds(tenantId: string, kernelId: string): Promise<string[]>;
  close?(): Promise<void>;
}
