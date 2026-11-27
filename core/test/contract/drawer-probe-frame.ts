import { connect } from '../../sdk/frame.ts'

// The probe's frame script: the frame's SDK as a shipped plugin's frame uses it, held where a test's evaluate reaches
// it, with what the worker posted kept in order
void connect().then(view => {
  const received: unknown[] = []
  view.onMessage(data => void received.push(data))
  Object.assign(globalThis, { probeFrame: { view, received } })
})
