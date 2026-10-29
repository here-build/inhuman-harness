import { KernelPlexus, SessionPlexus } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { bindSessionCatalog, catalogOf, catalogRecipe, KernelToolCatalog, type CatalogEntry } from "../index.js";

function packEntry(wireName: string, pluginName: string): CatalogEntry {
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: "effect",
    source: { kind: "pack", pluginName },
  };
}

describe("catalog instance isolation", () => {
  it("two catalogs with the same workspace path do not share project recipes", () => {
    const path = "/tmp/same-workspace";
    const left = new KernelToolCatalog();
    const right = new KernelToolCatalog();
    left.replacePack([packEntry("left-only", "left")]);
    right.replacePack([packEntry("right-only", "right")]);
    left.bindProjectRecipes(path, [
      catalogRecipe({
        name: "scout",
        category: "plugin",
        description: "left overlay",
      }),
    ]);
    right.bindProjectRecipes(path, [
      catalogRecipe({
        name: "scout",
        category: "plugin",
        description: "right overlay",
      }),
    ]);

    const leftKernel = KernelPlexus.bootstrap();
    const rightKernel = KernelPlexus.bootstrap();
    const leftSession = SessionPlexus.create("s-left", path);
    const rightSession = SessionPlexus.create("s-right", path);
    bindSessionCatalog(leftSession.root, left);
    bindSessionCatalog(rightSession.root, right);

    const leftView = left.view();
    leftView.projectRecipes = [...left.projectRecipesOf(path)];
    const rightView = right.view();
    rightView.projectRecipes = [...right.projectRecipesOf(path)];

    expect({
      kernels: leftKernel.root !== rightKernel.root,
      sessions: leftSession.root !== rightSession.root,
      samePath: leftSession.root.path === rightSession.root.path,
      leftTool: catalogOf(leftSession.root)?.catalogEntry("left-only")?.source,
      rightMissesLeft: catalogOf(rightSession.root)?.catalogEntry("left-only"),
      rightTool: catalogOf(rightSession.root)?.catalogEntry("right-only")?.source,
      leftOverlay: left.projectRecipesOf(path).map((recipe) => recipe.spec.description),
      rightOverlay: right.projectRecipesOf(path).map((recipe) => recipe.spec.description),
      leftViewRecipe: leftView.recipe("scout")?.spec.description,
      rightViewRecipe: rightView.recipe("scout")?.spec.description,
      kernelMiss: left.recipe("scout"),
    }).toEqual({
      kernels: true,
      sessions: true,
      samePath: true,
      leftTool: { kind: "pack", pluginName: "left" },
      rightMissesLeft: undefined,
      rightTool: { kind: "pack", pluginName: "right" },
      leftOverlay: ["left overlay"],
      rightOverlay: ["right overlay"],
      leftViewRecipe: "left overlay",
      rightViewRecipe: "right overlay",
      kernelMiss: undefined,
    });

    left[Symbol.dispose]();
    expect({
      leftGone: catalogOf(leftSession.root),
      leftRecipes: left.projectRecipesOf(path),
      rightStill: catalogOf(rightSession.root)?.catalogEntry("right-only")?.source,
      rightOverlay: right.projectRecipesOf(path).map((recipe) => recipe.spec.description),
    }).toEqual({
      leftGone: undefined,
      leftRecipes: [],
      rightStill: { kind: "pack", pluginName: "right" },
      rightOverlay: ["right overlay"],
    });

    right[Symbol.dispose]();
    leftKernel.destroy();
    rightKernel.destroy();
    leftSession.destroy();
    rightSession.destroy();
  });
});
