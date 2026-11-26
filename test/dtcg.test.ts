import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseColor, toDtcg } from "../src/tokens/dtcg.js";

test("colors parse from hex and rgba", () => {
  assert.deepEqual(parseColor("#2B3FE0"), { components: [0.1686, 0.2471, 0.8784], alpha: 1, hex: "#2b3fe0" });
  assert.equal(parseColor("rgba(255, 0, 0, 0.5)")!.alpha, 0.5);
  assert.equal(parseColor("red"), null);
});

test("variables become DTCG 2025.10 files with a resolver", () => {
  const out = toDtcg(
    {
      collections: [{ name: "Primitives", modes: [{ name: "Value" }] }, { name: "Semantic", modes: [{ name: "Light" }, { name: "Dark" }] }],
      variables: [
        { name: "blue/500", collection: "Primitives", type: "COLOR", values: { Value: "#2B3FE0" } },
        { name: "space/4", collection: "Primitives", type: "FLOAT", values: { Value: 16 }, scopes: ["GAP"] },
        { name: "opacity/muted", collection: "Primitives", type: "FLOAT", values: { Value: 0.6 } },
        { name: "color/pen", collection: "Semantic", type: "COLOR", description: "Actions", values: { Light: { alias: "blue/500" }, Dark: "#8592FF" } }
      ]
    },
    { name: "Daybook" }
  );
  const prim = out.files["primitives/value.tokens.json"] as any;
  assert.deepEqual(prim.blue["500"], { $type: "color", $value: { colorSpace: "srgb", components: [0.1686, 0.2471, 0.8784], alpha: 1, hex: "#2b3fe0" } });
  assert.deepEqual(prim.space["4"], { $type: "dimension", $value: { value: 16, unit: "px" }, $extensions: { "com.figma": { scopes: ["GAP"] } } });
  assert.deepEqual(prim.opacity.muted, { $type: "number", $value: 0.6 });
  const light = out.files["semantic/light.tokens.json"] as any;
  assert.equal(light.color.pen.$value, "{blue.500}");
  assert.equal(light.color.pen.$description, "Actions");
  const r = out.files["daybook.resolver.json"] as any;
  assert.equal(r.version, "2025.10");
  assert.deepEqual(r.sets.primitives.sources, [{ $ref: "primitives/value.tokens.json" }]);
  assert.deepEqual(r.modifiers.semantic.contexts.dark, [{ $ref: "semantic/dark.tokens.json" }]);
  assert.equal(r.modifiers.semantic.default, "light");
  assert.deepEqual(r.resolutionOrder, [{ $ref: "#/sets/primitives" }, { $ref: "#/modifiers/semantic" }]);
});

test("single-mode light and dark collections combine into one theme modifier", () => {
  const out = toDtcg(
    {
      collections: [{ name: "Daybook", modes: [{ name: "Light" }] }, { name: "Daybook Dark", modes: [{ name: "Dark" }] }],
      variables: [
        { name: "color/ink", collection: "Daybook", type: "COLOR", values: { Light: "#1A2147" } },
        { name: "color/ink", collection: "Daybook Dark", type: "COLOR", values: { Dark: "#E8EAF4" } },
        { name: "space/4", collection: "Daybook", type: "FLOAT", values: { Light: 16 } }
      ]
    },
    { name: "Daybook", themeCollections: ["Daybook", "Daybook Dark"] }
  );
  const r = out.files["daybook.resolver.json"] as any;
  assert.deepEqual(Object.keys(r.modifiers.theme.contexts), ["daybook", "daybook-dark"]);
  assert.equal(r.modifiers.theme.default, "daybook");
  // Spacing exists only in the light collection, so it moves to a base set every theme gets.
  assert.deepEqual(r.sets["daybook-base"].sources, [{ $ref: "daybook-base/value.tokens.json" }]);
  assert.deepEqual(r.resolutionOrder, [{ $ref: "#/sets/daybook-base" }, { $ref: "#/modifiers/theme" }]);
  assert.equal((out.files["daybook/light.tokens.json"] as any).space, undefined);
  assert.deepEqual((out.files["daybook-base/value.tokens.json"] as any).space["4"].$value, { value: 16, unit: "px" });
});
