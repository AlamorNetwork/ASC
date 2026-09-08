import { run } from './src/app.js';

run().catch((err) => {
  console.error('[asc] fatal:', err);
  process.exit(1);
});
