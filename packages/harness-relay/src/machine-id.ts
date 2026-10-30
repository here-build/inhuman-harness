const MACHINE_ID = /^[\w-]{1,64}$/;

export function isMachineId(s: string): boolean {
  return MACHINE_ID.test(s);
}
