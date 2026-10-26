import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", ".out/"] },
  js.configs.recommended,
  { languageOptions: { globals: { ...globals.node, document: "readonly", getComputedStyle: "readonly", window: "readonly", scrollX: "readonly", scrollY: "readonly" } } },
];
