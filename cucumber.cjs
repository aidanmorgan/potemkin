/** @type {import('@cucumber/cucumber').IConfiguration} */
module.exports = {
  default: {
    paths: [
      "tests/bdd/features/traceability.feature",
      "tests/bdd/features/typescript-parity.feature",
    ],
    require: ["tests/bdd/support/resolver-hook.cjs", "tests/bdd/steps/traceability.steps.ts"],
    requireModule: ["ts-node/register/transpile-only"],
    format: ["progress"],
    strict: true,
    worldParameters: {},
  },
};
