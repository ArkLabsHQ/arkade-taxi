import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["**/dist/", "**/node_modules/", "vendor/", "packages/app/src/admin/static/"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettier,
    { languageOptions: { globals: { ...globals.node, EventSource: "readonly" } } },
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
            ],
            "no-empty": ["error", { allowEmptyCatch: true }],
            "no-regex-spaces": "off",
            "no-unsafe-finally": "off",
            "prefer-const": "warn",
            "no-control-regex": "warn",
            "preserve-caught-error": "warn",
            "@typescript-eslint/no-empty-object-type": "warn",
            "no-useless-assignment": "off",
            "require-yield": "off",
            "@typescript-eslint/no-unsafe-function-type": "off",
        },
    },
);
