{
  "parser": "@typescript-eslint/parser",
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "module",
    "project": "./tsconfig.json"
  },
  "env": {
    "node": true,
    "es2022": true
  },
  "rules": {
    "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/ban-types": ["error", {
      "types": {
        "Function": false,
        "Object": false,
        "String": false,
        "Number": false,
        "Boolean": false
      }
    }],
    "@typescript-eslint/no-duplicate-enum-values": "error",
    "@typescript-eslint/ban-ts-comment": "warn",
    "no-prototype-builtins": "error",
    "no-useless-catch": "error",
    "prefer-const": "warn",
    "no-var": "error",
    "no-case-declarations": "warn",
    "@typescript-eslint/no-this-alias": ["error", { "allowDestructuring": true }],
    "@typescript-eslint/no-var-requires": "warn",
    "no-constant-condition": ["warn", { "checkLoops": false }],
    "eqeqeq": "warn",
    "curly": "warn",
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-new-func": "error",
    "no-throw-literal": "error",
    "no-unneeded-ternary": "warn",
    "prefer-arrow-callback": "warn",
    "prefer-template": "warn",
    "yoda": "warn"
  },
  "ignorePatterns": [
    "**/*.bak/**",
    "**/*.bak",
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "src/commands/offline-log.ts",
    "web-interface/node_modules/**",
    "src/**/*.js"
  ],
  "overrides": [
    {
      "files": [
        "src/logging/**/*.{ts,js}",
        "src/types/**/*.{ts,js}",
        "src/modules/enhancement/**/*.{ts,js}",
        "src/modules/resource/**/*.{ts,js}",
        "src/modules/initialization/**/*.{ts,js}",
        "src/modules/debug/**/*.{ts,js}",
        "src/modules/unimplemented-*.ts",
        "src/modules/unimplemented-*/**/*.{ts,js}",
        "src/commands/**/*.{ts,js}"
      ],
      "rules": {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "@typescript-eslint/no-var-requires": "off",
        "no-case-declarations": "off",
        "curly": "off",
        "eqeqeq": "off",
        "prefer-const": "off"
      }
    }
  ]
}
