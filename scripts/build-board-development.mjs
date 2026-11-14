// A development build keeps React's StrictMode checks for the e2e "development" project. NODE_ENV is set
// here, before Vite loads, because `NODE_ENV=... vite build` does not work in Windows shells.
process.env.NODE_ENV = 'development';
const { build } = await import('vite');
await build({ logLevel: 'warn', build: { outDir: '../../.e2e/development/board/dist', emptyOutDir: true } });
