import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "supabase/.branches/**",
      "supabase/.temp/**",
      // Generated esbuild output (npm run build:wallet-bridge) — never lint
      // build artifacts; fix the source in wallet-bridge/ instead.
      "public/wallet-bridge.js",
      "public/wallet-bridge.js.map",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // CommonJS files: `require()` is the correct module system here
  // (hardhat.config.cjs is required by Hardhat; scripts/*.js run under Node CJS).
  {
    files: ["**/*.cjs", "scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Hardhat test files use chai-style expression assertions — the trailing
  // expression IS the test (`expect(x).to.equal(y)` chains).
  {
    files: ["test/**/*.js"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
];

export default eslintConfig;
