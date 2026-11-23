// Loaded before main in an e2e run from the source. An exception nothing in main caught ends the run with its error on
// stderr, so the test fails on it rather than waiting on the modal error dialog Electron shows when no other listener
// is there
process.on('uncaughtException', err => {
  process.stderr.write(`main threw: ${err && err.stack ? err.stack : String(err)}\n`)
  process.exit(1)
})
