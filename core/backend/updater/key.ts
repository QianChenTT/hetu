// The public half of the key that signs hetu's update file, Ed25519 as SPKI in PEM. It sits in main.js inside app.asar,
// which ASAR integrity covers. The private half never leaves the publisher's machine, so an update file signed by any
// other key is refused, a release made through a taken over GitHub account among them
export const UPDATE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXT7tpaC+9QHdT83xtFvsCdZ65VOWHqUaFypE2lsWaPI=
-----END PUBLIC KEY-----
`
