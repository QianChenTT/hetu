import { agentConnect, type AgentConnect } from '../../api/changes.ts'
import { agentDoor } from '../../api/slots.ts'

// A client's connect through http's door: the change the core raises for it. The hosts are taken here with the URL
// parser http's own process uses, so the host the human reads is the one http reaches

// What http sends for a connect: the client id, the name the client's document gives or null, the redirect and the
// number of the authorization
export type ConnectAsked = { client: string, name: string | null, redirect: string, number: number }

// An address's host with its port where one is named, null for text that is no URL or a URL with no host. user says it
// names a user or a password before the host, which can make it read as another host
function hostOf(address: string): { host: string, user: boolean } | null {
  if (!URL.canParse(address)) return null
  const url = new URL(address)
  return url.host === '' ? null : { host: url.host, user: url.username !== '' || url.password !== '' }
}

// The connect as the human is shown it, or null for one the core refuses: a redirect with no host, a client id or a
// redirect with user info, or values out of the kind's form, a client id and a number that make no label among them
export function connectChange(asked: ConnectAsked): AgentConnect | null {
  const to = hostOf(asked.redirect)
  const from = hostOf(asked.client)
  if (to === null || to.user || from?.user === true) return null
  const change = {
    kind: 'agent.connect' as const, plugin: agentDoor.plugin, client: asked.client, clientHost: from?.host ?? null, name: asked.name,
    redirect: asked.redirect, redirectHost: to.host, number: asked.number,
  }
  return agentConnect.safeParse(change).success ? change : null
}
