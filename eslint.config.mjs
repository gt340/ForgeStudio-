import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Real lint config (the previous file was empty, so `eslint` linted nothing meaningful).
// `next lint` no longer exists in Next 16; plain `eslint` with this flat config is the supported mechanism.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'coverage/**', 'next-env.d.ts', 'mobile-wrapper/**', 'scripts/**']),
  {
    rules: {
      // The existing codebase uses these widely; they are reported as warnings rather than failing CI.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@next/next/no-img-element': 'warn',
      'react/no-unescaped-entities': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      // React-Compiler advisory rules (new in eslint-plugin-react-hooks 7). They flag patterns that work
      // correctly today (e.g. fetching data on mount); kept visible as warnings, not build failures.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },
]);
