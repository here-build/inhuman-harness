import { expect, test } from "vitest";

import { qdPackageName, resolveQdBinary } from "../rust-present.js";

const CARGO = "cargo build --release --manifest-path packages/quickdraw/rust/qd/Cargo.toml";

function resolveWith(opts: {
  prebuiltExists?: boolean;
  prebuiltExecutable?: boolean;
  devExists?: boolean;
  devExecutable?: boolean;
  missingPackage?: boolean;
}): string {
  return resolveQdBinary({
    platform: "darwin",
    arch: "arm64",
    devBinary: "/repo/target/release/qd",
    resolvePackageJson: () => {
      if (opts.missingPackage) throw new Error("MODULE_NOT_FOUND");
      return "/pkg/qd-darwin-arm64/package.json";
    },
    exists: (file) => {
      if (file === "/pkg/qd-darwin-arm64/qd") return opts.prebuiltExists ?? false;
      if (file === "/repo/target/release/qd") return opts.devExists ?? false;
      return false;
    },
    executable: (file) => {
      if (file === "/pkg/qd-darwin-arm64/qd") return opts.prebuiltExecutable ?? false;
      if (file === "/repo/target/release/qd") return opts.devExecutable ?? false;
      return false;
    },
  });
}

test("qd package name follows platform and arch", () => {
  expect(qdPackageName("darwin", "arm64")).toBe("@inhuman.tools/qd-darwin-arm64");
  expect(qdPackageName("linux", "x64")).toBe("@inhuman.tools/qd-linux-x64");
});

test("an executable prebuilt wins over the repo build", () => {
  expect(
    resolveWith({
      prebuiltExists: true,
      prebuiltExecutable: true,
      devExists: true,
      devExecutable: true,
    }),
  ).toBe("/pkg/qd-darwin-arm64/qd");
});

test("a missing optional package falls through to the repo build", () => {
  expect(resolveWith({ missingPackage: true, devExists: true, devExecutable: true })).toBe("/repo/target/release/qd");
});

test("a prebuilt that is not executable falls through to the repo build", () => {
  expect(
    resolveWith({
      prebuiltExists: true,
      prebuiltExecutable: false,
      devExists: true,
      devExecutable: true,
    }),
  ).toBe("/repo/target/release/qd");
});

test("no binary names the package and the cargo command", () => {
  expect(() => resolveWith({ missingPackage: true })).toThrow(CARGO);
  expect(() => resolveWith({ missingPackage: true })).toThrow("@inhuman.tools/qd-darwin-arm64");
  expect(() => resolveWith({ missingPackage: true })).toThrow("/repo/target/release/qd");
});
