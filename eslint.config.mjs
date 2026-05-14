import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import obsidian from "eslint-plugin-obsidianmd";

export default [
  // Obsidian plugin rules (flat config array — includes TypeScript parser and rules)
  ...obsidian.configs.recommended,

  // Augment with type-aware parsing and additional rules scoped to src/
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json" },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-require-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": ["error", { allow: ["warn", "error", "debug"] }],
    },
  },
];
