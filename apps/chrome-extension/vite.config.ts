import { defineConfig } from 'vite';

// vite 8 dist/node/index.d.ts:2911 — rolldownOptions (rollupOptions 는 deprecated 별칭)
export default defineConfig(({ mode }) => {
  const isContent = mode === 'content';

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: !isContent,
      minify: false,
      rolldownOptions: isContent
        ? {
            input: 'src/content.ts',
            output: {
              format: 'iife',
              entryFileNames: 'content.js',
              extend: true,
            },
          }
        : {
            input: 'src/background.ts',
            output: {
              format: 'es',
              entryFileNames: 'background.js',
            },
          },
    },
  };
});
