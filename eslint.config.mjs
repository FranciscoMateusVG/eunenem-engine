// @ts-check
//
// ESLint config — Frame uses ESLint solely as a structural gate via
// eslint-plugin-project-structure. Biome remains the lint + format authority.
// No other ESLint rules are enabled here.
//
// Scope is narrow on purpose: only the architectural directories below get
// checked. Root config files, dotfile folders (.claude/.husky/.github),
// docker/, and generated artifacts are intentionally out of scope.
//
// See folder-structure.mjs for the rule body.

import { projectStructureParser, projectStructurePlugin } from 'eslint-plugin-project-structure';
import { folderStructureConfig } from './folder-structure.mjs';

export default [
  // Global ignores — in flat config, an entry with only `ignores` is global
  // (vs `ignores` paired with `files`, which only filters within that block).
  // Side-deploy apps under apps/ have their own tooling and must not be
  // walked by the engine's structural gate.
  {
    ignores: ['apps/**', 'dist/**', 'coverage/**', 'node_modules/**', 'tmp/**'],
  },
  {
    files: [
      'src/**/*.{ts,mts}',
      'tests/**/*.{ts,mts}',
      'examples/**/*.{ts,mts}',
      'migrations/**/*.ts',
      'scripts/**/*.{ts,mts,js,cjs,mjs}',
    ],
    ignores: [
      '**/*.generated.ts',
      '**/*.d.ts',
      'projectStructure.cache.json',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'tmp/**',
    ],
    languageOptions: { parser: projectStructureParser },
    plugins: {
      'project-structure': projectStructurePlugin,
    },
    rules: {
      'project-structure/folder-structure': ['error', folderStructureConfig],
    },
  },
];
