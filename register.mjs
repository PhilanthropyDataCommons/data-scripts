// Register ts-node's ESM loader so the `.js` specifiers required by ESM
// (e.g. `import { candid } from './candid.js'`) resolve to their `.ts`
// source when running scripts directly from src/ via `npm run <script>`.
// The compiled output in dist/ needs no loader: there the `.js` files exist.
// Authored by GLM-5.2.
import { register } from 'node:module';

register('ts-node/esm', import.meta.url);
