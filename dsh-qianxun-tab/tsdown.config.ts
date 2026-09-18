import { clientBundle } from '../../client/tsdown.client.ts'

// Shared client-bundle preset for UI plugins: emits the node half (ESM
// lib/index.js) plus the browser client bundle (closure-factory lib/client.js).
// The client entry is `src/client/index.ts` by convention; the node side is
// driven by `lib/types/index.js` so only type declarations survive (the empty
// node apply carries no runtime code of its own).
export default clientBundle('@deepseek-ai/dsh-qianxun-tab', ['lib/types/index.js'])
