import { rm } from 'node:fs/promises';
// Remove only regenerable compiler output; never touch the local data directory.
await rm(new URL('../dist/server/', import.meta.url), {recursive:true,force:true});
