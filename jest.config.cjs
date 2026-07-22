module.exports = {
  transform: {
    '^.+[.]tsx?$': [
      'ts-jest',
      {
        // The project is `"type": "module"`, so jest runs in ESM mode
        // (see the `test` script's `--experimental-vm-modules` flag).
        // ts-jest emits ESM and keeps `module: nodenext` from tsconfig.dev.json,
        // which correctly resolves `exports` subpaths such as `csv-parse/sync`.
        // Type-checking of tests is also covered by `npm run lint:tsc`.
        // Authored by GLM-5.2.
        tsconfig: 'tsconfig.dev.json',
        useESM: true,
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  moduleNameMapper: {
    '^([.]{1,2}/.*)[.]js$': '$1',
  },
  testMatch: ['**/*.unit.test.ts'],
  passWithNoTests: true,
  silent: true,
};
