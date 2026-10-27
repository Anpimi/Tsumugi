import babelParser from "@babel/eslint-parser";

export default [{
  files: ["src/app-v2/**/*.{ts,tsx}"],
  languageOptions: {
    parser: babelParser,
    parserOptions: { requireConfigFile: false, babelOptions: { parserOpts: { plugins: ["typescript", "jsx"] } } },
  },
  rules: {
    "no-restricted-syntax": ["error", {
      selector: "JSXOpeningElement[name.name=/^(button|select|details)$/]",
      message: "Use the matching design-system component.",
    }],
  },
}];
