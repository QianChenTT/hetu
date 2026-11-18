import { PORT, refuseEveryToken } from './checks.ts'
import { httpPlugin } from './keeper.ts'

// The door on 127.0.0.1:4747. No token is issued yet, so every request that passes the checks before the token answers
// 401
export default httpPlugin({ port: PORT, token: refuseEveryToken })
