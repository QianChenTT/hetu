The log, an install plugin whose host half holds the log slot. The loader lends it an audit handle for each incarnation. It pulls the audit records through it every 100 ms, writes them in batches with one fsync each and acknowledges each batch once it is written. It chooses which records to write and when, never what they say: the handle writes the core's own copy of each. It also serves `log.history` and `log.verify`, which windows reach with `log.read`

A log that stops acknowledging for 30 s is marked failed by the carrier, so with the gate off a call with power is refused rather than passing unlogged

`src/log.ts` holds the logic. `src/host.ts` is what the loader imports: the plugin as its default export, the `log` role and the `provider`
