import { userInfo } from 'node:os'
import { pipeName } from 'hetu-core/api/pipe.ts'
import { PORT, refuseEveryToken } from './checks.ts'
import { httpPlugin } from './keeper.ts'

// The door on 127.0.0.1:4747 and the user's local pipe beside it. No token is issued yet, so every request at the door
// that passes the checks before the token answers 401, while the pipe joins each client the human confirms
export default httpPlugin({ port: PORT, token: refuseEveryToken, pipe: pipeName(process.platform, userInfo().username) })
