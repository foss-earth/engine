import tseslint from "typescript-eslint";
export default tseslint.config({ ignores: ["dist/**", "build/**", "node_modules/**"] }, ...tseslint.configs.recommended, { files: ["scripts/**/*.mjs", "fixtures/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } } });
