// Runs first in every worker, in the same script as the plugin's bytes, copied in as written. Removes each constructor
// that starts another global, so a plugin can't open a realm the core doesn't know about. The plugin's top-level
// declarations exist before any of this runs, so the global object is reached through top-level this, which no
// declaration can rebind, never through a name like globalThis or self. One block, so its names can't clash with the
// plugin's, and no strict mode, which would carry over to the plugin's code. A removal that didn't take throws, which
// stops the whole script before any of the plugin's code runs
{
  const scope = this
  const names = ['Worker', 'SharedWorker']
  for (let i = 0; i < names.length; i++) {
    delete scope[names[i]]
    if (names[i] in scope) throw new Error('hetu: ' + names[i] + ' could not be removed')
  }
}
