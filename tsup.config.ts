import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    clean: false,
    splitting: false,
    dts: false,
    outDir: 'dist',
  },
  {
    // CJS: @actions/* are CommonJS packages; the node24 Actions runtime executes this
    // directly (action.yml `using: node24` — node20 is EOL on Actions runners).
    entry: { 'action/index': 'src/action/index.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    clean: false,
    splitting: false,
    dts: false,
    outDir: 'dist',
  },
]);
