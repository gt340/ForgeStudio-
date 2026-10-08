import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// .mts so the config loads as an ES module: vite-tsconfig-paths is ESM-only and cannot be loaded from
// a CommonJS config (this is why `npm test` failed to even start in CI with vitest.config.ts).
export default defineConfig({
  plugins: [tsconfigPaths()],
  // the tsconfig uses jsx: preserve (for Next); tests need JSX actually compiled
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['app/api/**/*.ts', 'lib/**/*.ts'],
    },
  },
});
