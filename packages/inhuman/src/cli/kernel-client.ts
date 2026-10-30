/**
 * Transport lives in the sdk; spawning the daemon stays here.
 */
import { ensure } from "@inhuman.tools/harness";
import { step } from "@inhuman.tools/harness-diagnostics";
import { Client, type KernelRpc } from "@inhuman.tools/harness-sdk";

export async function openKernelRpc(kernelPath: string): Promise<KernelRpc> {
  await ensure(kernelPath);
  step(`kernel rpc ${kernelPath}`);
  return Client.kernel(kernelPath);
}
