import { test } from "node:test";
import { strict as assert } from "node:assert";
import { toYaml } from "../src/util/yaml.js";

test("emits nested objects and arrays", () => {
  const y = toYaml({ nodes: [{ id: "1:2", name: "Frame", children: [{ id: "3:4", text: "Hello: world" }] }], n: 3, flag: true, list: ["a", "b"] });
  assert.equal(
    y,
    ['nodes:', '  - id: "1:2"', "    name: Frame", "    children:", '      - id: "3:4"', '        text: "Hello: world"', "n: 3", "flag: true", "list: [a, b]"].join("\n")
  );
});

test("quotes ambiguous scalars", () => {
  assert.equal(toYaml({ a: "true", b: "12", c: "#FFF" }), 'a: "true"\nb: "12"\nc: "#FFF"');
});
