// Runs first in every worker, in the same script as the plugin's bytes. Removes each constructor that starts another
// global, so a plugin can't open a realm the core doesn't know about
for (const name of ['Worker', 'SharedWorker']) {
  try {
    delete (globalThis as Record<string, unknown>)[name]
  } catch {}
}
