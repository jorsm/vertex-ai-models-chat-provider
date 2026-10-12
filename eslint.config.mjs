import js from "@eslint/js";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import eslintConfigPrettier from "eslint-config-prettier/flat";

const sourceFiles = ["src/**/*.ts"];

export default [
    {
        ignores: [
            "out/**",
            "dist/**",
            "node_modules/**",
            "playground/**",
        ],
    },
    { ...js.configs.recommended, files: sourceFiles },
    ...typescriptEslint.configs["flat/recommended"].map((config) => ({ ...config, files: sourceFiles })),
    {
        files: sourceFiles,
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: "module",
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },

        rules: {
            "@typescript-eslint/naming-convention": [
                "warn",
                {
                    selector: "import",
                    format: [
                        "camelCase",
                        "PascalCase",
                    ],
                },
            ],

            // SDK payloads still use dynamic types; tightening them is a separate migration.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
            ],
            "@typescript-eslint/no-floating-promises": [
                "error",
                { checkThenables: true },
            ],
            "@typescript-eslint/no-misused-promises": "error",
            // Timer and cancellation callbacks capture handles before their assignment.
            "prefer-const": [
                "error",
                { ignoreReadBeforeAssign: true },
            ],
            curly: "error",
            eqeqeq: "error",
            "no-throw-literal": "error",
        },
    },
    eslintConfigPrettier,
];
