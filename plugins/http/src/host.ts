import { refuseEveryToken } from './checks.ts'
import { httpPlugin } from './keeper.ts'

// The door on 127.0.0.1 and the port the core names. No token is issued yet, so every request that passes the checks
// before the token answers 401
export default httpPlugin({ token: refuseEveryToken })
