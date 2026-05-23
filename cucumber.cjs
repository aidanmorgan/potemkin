/** @type {import('@cucumber/cucumber').IConfiguration} */
module.exports = {
  default: {
    paths: ['tests/bdd/features/**/*.feature'],
    require: [
      'tests/bdd/support/resolver-hook.cjs',
      'tests/bdd/support/**/*.ts',
      'tests/bdd/steps/**/*.ts',
    ],
    requireModule: ['ts-node/register/transpile-only'],
    format: ['progress'],
    strict: true,
    worldParameters: {},
  },
};
