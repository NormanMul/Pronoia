import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/bootstrap.ts',
      formats: ['cjs'],
      fileName: () => 'bootstrap.cjs',
    },
  },
});
