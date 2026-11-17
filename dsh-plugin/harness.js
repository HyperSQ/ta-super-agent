import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve shipped packages from the running Host so scoped service identities
// are shared with DSH, including when the desktop Host is inside app.asar.
export async function harnessPackage(name) {
  let entry;
  try { entry = import.meta.resolve(name); }
  catch {
    const host = createRequire(pathToFileURL(process.argv[1]));
    entry = pathToFileURL(host.resolve(name)).href;
  }
  return import(entry);
}
