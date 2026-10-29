import { describe, expect, it } from "vitest";

import { reasonableDefaults } from "../reasonable-defaults.js";
import type { Disposition } from "../types.js";
import { compile } from "./_helpers/compile.js";

/**
 * The shipped defaults hard-block the commands whose one run cannot be undone. `block` is the
 * only verdict no permission mode lifts; everything else destructive stays a soft `deny`.
 */
const CASES: readonly (readonly [string, Disposition])[] = [
  // rm: recursive over root or home, and --no-preserve-root anywhere
  ["rm -rf /", "block"],
  ["rm -r /", "block"],
  ["rm -fr /", "block"],
  ["rm -Rf /", "block"],
  ["rm --recursive --force /", "block"],
  ["rm -rf /*", "block"],
  ["rm -rf //", "block"],
  ["rm -rf /.", "block"],
  ["rm -rf ~", "block"],
  ["rm -rf ~/", "block"],
  ["rm -rf ~/*", "block"],
  ["rm -rf $HOME", "block"],
  ["rm -rf ${HOME}", "block"],
  ['rm -rf "$HOME"', "block"],
  ["rm -rf $HOME/", "block"],
  ["rm -rf --no-preserve-root /", "block"],
  ["rm --no-preserve-root -rf /", "block"],
  ["rm --no-preserve-root x", "block"],
  ["rm -rf /tmp/x /", "block"],
  ["sudo rm -rf /", "block"],
  ["bash -c 'rm -rf /'", "block"],
  ["xargs rm -rf /", "block"],
  ["ls && rm -rf ~", "block"],
  // rm that stays soft or ordinary
  ["rm -rf /tmp/x", "ask"],
  ["rm -rf ./build", "ask"],
  ["rm file", "ask"],
  ["rm /etc/passwd", "deny"],
  // filesystem creation and signature wipes
  ["mkfs /dev/sda1", "block"],
  ["mkfs -t ext4 /dev/sda1", "block"],
  ["mkfs.ext4 /dev/sda1", "block"],
  ["mkfs.xfs -f /dev/nvme0n1", "block"],
  ["mkfs.btrfs /dev/sdb", "block"],
  ["mke2fs /dev/sdb1", "block"],
  ["wipefs -a /dev/sda", "block"],
  ["shred -n 3 file", "block"],
  ["shred /dev/sda", "block"],
  // partition editors: writes block, listings stay soft
  ["fdisk /dev/sda", "block"],
  ["sfdisk /dev/sda", "block"],
  ["parted /dev/sda mklabel gpt", "block"],
  ["parted /dev/sda rm 1", "block"],
  ["fdisk -l", "deny"],
  ["sfdisk --list", "deny"],
  ["parted -l", "deny"],
  ["parted /dev/sda print", "deny"],
  // dd onto a device
  ["dd if=/dev/zero of=/dev/sda", "block"],
  ["dd if=x.img of=/dev/disk2 bs=1m", "block"],
  ["dd of=/dev/nvme0n1p1 if=x", "block"],
  ["dd if=x of=/dev/./sda", "block"],
  ["dd if=/dev/zero of=/dev/null", "deny"],
  ["dd if=x of=out.img", "deny"],
  ["dd if=/dev/zero", "deny"],
  // recursive chmod/chown over root or home
  ["chmod -R 755 /", "block"],
  ["chmod -R 777 ~", "block"],
  ["chmod -R u+w $HOME", "block"],
  ["chown -R user /", "block"],
  ["chown -R user:group ~/", "block"],
  ["chown --recursive user $HOME", "block"],
  ["chown -R user x", "deny"],
  ["chmod -R 755 build", "ask"],
  ["chmod 777 x", "deny"],
];

describe("catastrophic commands are a hard block in the shipped defaults", () => {
  it("verdict table", async () => {
    const policy = await compile(reasonableDefaults);
    expect(Object.fromEntries(CASES.map(([command]) => [command, policy.bash(command)]))).toEqual(
      Object.fromEntries(CASES),
    );
  });

  it("the cwd a command runs in does not soften it", async () => {
    const policy = await compile(reasonableDefaults);
    expect(policy.bash("rm -rf /", "packages/x")).toBe("block");
    expect(policy.bash("mkfs.ext4 /dev/sda", "packages/x")).toBe("block");
  });
});
