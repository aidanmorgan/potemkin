/** @type {import('@cucumber/cucumber').IConfiguration} */
module.exports = {
  paths: ['tests/bdd/features/**/*.feature'],
  require: [
    'tests/bdd/support/**/*.ts',
    'tests/bdd/steps/**/*.ts',
  ],
  requireModule: ['ts-node/register'],
  format: ['progress'],
  strict: false,
};
