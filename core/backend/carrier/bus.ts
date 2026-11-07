import { VERSION, type BusSignal, type Caller } from '../../api/envelope.ts'
import type { FloorConstant } from '../../api/floor.ts'

type Send = (message: unknown) => void

// How a path event goes out now: the gate's canRead decides for each subscriber, every path passes with the gate off by
// the human, or every path is held back while the gate is down
export type Paths = 'ask' | 'all' | 'none'

// What the carrier lends the bus. key moves whenever the gate's state, whether it can be asked or the StateView does,
// which is when the bus asks the gate about its subscriptions again. view is the StateView number, null when unreadable
export type BusParts = {
  state(): { key: string, paths: Paths, view: number | null }
  canRead(caller: Caller, path: string): boolean
  // The gate's answer on one subscription it holds: allow, refuse, which ends it, or down when the gate gave no answer,
  // which holds it back until the gate allows it
  recheck(caller: Caller, topic: string): 'allow' | 'refuse' | 'down'
  limit(plugin: string | null, name: FloorConstant): number
  // Drops are counted for the floor lane. A change asking again made is recorded with the topics: subscriptions ended,
  // started once the gate allowed them, or held back to wait for the gate
  dropped(caller: Caller, why: 'credits' | 'gate-down'): void
  changed(caller: Caller, change: 'ended' | 'started' | 'waiting', topics: string[]): void
}

// A half or a window as the carrier names it. owner is its way in, so a way that ends takes its subscriptions and its
// credits with it and a new incarnation starts with none. plugin is whose limits apply, null for a window. A window's
// events go back the way its newest subscribe came
export type Holder = { owner: object, caller: Caller, plugin: string | null, push: Send, alive: () => boolean }

type Subscription = {
  // Needs no gate: a plugin's own topic, or a core topic a window hears
  free: boolean
  // false while it stands, made with the gate down or held back since, waiting for the gate to allow it
  live: boolean
  // A path event may have been held back from it since the gate went down, so it reads again once the gate is up
  resync: boolean
  // The StateView the gate last allowed it on, null when no gate has judged it: free, or taken with the gate off by the
  // human. A gated subscription hears anything only while this is the current StateView or the gate is off
  judged: number | null
}

type Subscriber = {
  caller: Caller
  plugin: string | null
  push: Send
  alive: () => boolean
  // One subscription per topic, so a repeat replaces it
  topics: Map<string, Subscription>
  // The seq of the last event sent and the highest one acknowledged. What lies between is in flight
  sent: number
  acked: number
  // Topics whose events were dropped past the credits. Nothing more goes out until every event sent is acknowledged,
  // then one events.dropped names them
  missed: Set<string> | null
}

// core.* is path-less by rule, every other topic may carry a path
const pathless = (topic: string) => topic.startsWith('core.')

// Subscriptions, credits and delivery. An event is a topic and maybe a path, never content. A path reaches only
// subscribers the gate says may read it. The carrier decides who may subscribe to and publish what before anything
// here runs
export class Bus {
  private readonly parts: BusParts
  private readonly subscribers = new Map<object, Subscriber>()
  // Subscribers by topic, live and standing, in the order they subscribed
  private readonly byTopic = new Map<string, Set<Subscriber>>()
  private key: string | null = null
  private paths: Paths = 'ask'
  private view: number | null = null
  // A subscription the gate gave no answer about waits, so the next sync asks again though the key didn't move
  private unsettled = false

  constructor(parts: BusParts) {
    this.parts = parts
  }

  // Whether the half's subscriptions stay within its cap once these topics are added. A topic it holds counts once
  fits(owner: object, topics: readonly string[], cap: number): boolean {
    const held = this.subscribers.get(owner)?.topics
    let count = held?.size ?? 0
    for (const topic of topics) if (held?.has(topic) !== true) count++
    return count <= cap
  }

  // Adds the half's subscriptions or replaces those it holds. free names the topics no gate holds. With the gate down a
  // new subscription the gate holds stands until the gate allows it while one already live stays live. A standing one
  // the call's own judgement now allows starts with events.dropped. Gives back the topics left standing
  subscribe(holder: Holder, topics: readonly string[], free: ReadonlySet<string>, down: boolean): string[] {
    const subscriber = this.subscriberOf(holder)
    const standing: string[] = []
    const started: string[] = []
    // The carrier synced the bus before judging the call, so with the gate asked the allow was on this StateView
    const judged = this.paths === 'ask' ? this.view : null
    for (const topic of topics) {
      const held = subscriber.topics.get(topic)
      if (held?.live === true) continue
      if (!free.has(topic) && down) {
        if (held === undefined) this.add(subscriber, topic, { free: false, live: false, resync: false, judged: null })
        standing.push(topic)
      } else if (held === undefined) {
        this.add(subscriber, topic, {
          free: free.has(topic), live: true, resync: this.paths === 'none' && !pathless(topic), judged: free.has(topic) ? null : judged,
        })
      } else {
        held.live = true
        held.judged = judged
        started.push(topic)
      }
    }
    if (started.length > 0) this.resync(subscriber, started)
    return standing
  }

  unsubscribe(owner: object, topics: readonly string[]): void {
    const subscriber = this.subscribers.get(owner)
    if (subscriber === undefined) return
    for (const topic of topics) this.remove(subscriber, topic)
  }

  // A way that ended takes its subscriptions and its credits with it
  drop(owner: object): void {
    const subscriber = this.subscribers.get(owner)
    if (subscriber === undefined) return
    this.subscribers.delete(owner)
    for (const topic of [...subscriber.topics.keys()]) this.remove(subscriber, topic)
  }

  // An event a plugin published on its own topic, to every live subscription of the topic. A path goes only to the
  // subscribers the gate says may read it and to none while the gate is down. Path-less events go out whatever the gate
  publish(topic: string, path: string | undefined): void {
    this.sync()
    for (const subscriber of [...this.byTopic.get(topic) ?? []]) {
      const held = subscriber.topics.get(topic)
      if (held === undefined || !held.live || !subscriber.alive()) continue
      if (path !== undefined) {
        if (this.paths === 'none') {
          held.resync = true
          this.parts.dropped(subscriber.caller, 'gate-down')
          continue
        }
        if (this.paths === 'ask' && !this.parts.canRead(subscriber.caller, path)) continue
      }
      this.deliver(subscriber, topic, path)
    }
  }

  // A core topic, to the windows that hear it and never to a plugin
  emit(topic: string): void {
    for (const subscriber of [...this.byTopic.get(topic) ?? []]) {
      if (subscriber.caller.kind !== 'window' || subscriber.topics.get(topic)?.live !== true || !subscriber.alive()) continue
      this.deliver(subscriber, topic, undefined)
    }
  }

  // The subscriber is done with its events up to seq. One past its credits that has caught up gets one events.dropped
  ack(owner: object, seq: number): void {
    const subscriber = this.subscribers.get(owner)
    if (subscriber === undefined) return
    const upTo = Math.min(seq, subscriber.sent)
    if (upTo <= subscriber.acked) return
    subscriber.acked = upTo
    if (subscriber.missed === null || subscriber.acked < subscriber.sent) return
    const missed = [...subscriber.missed]
    subscriber.missed = null
    // Empty once the subscriber gave up every topic it missed events on
    if (missed.length > 0) this.signal(subscriber, 'events.dropped', missed)
  }

  // Runs before anything the gate decides here, so a change the loader didn't report is still seen. While the gate is
  // down every live path subscription is marked, since a path may be held back from it. A gated subscription the gate
  // didn't allow on the current StateView waits too, path-less events included. Only an exact allow counts, so a
  // narrowing made during an outage holds back what it may have taken away. Once the gate is up again, or the StateView
  // moved, the bus asks about every subscription the gate holds. A refused one ends with events.ended. One the gate
  // gave no answer about waits and is asked again at every sync until it answers. Each subscriber with a marked or
  // newly started subscription gets one events.dropped. With the gate off by the human nothing is asked and everything
  // starts
  sync(): void {
    const { key, paths, view } = this.parts.state()
    if (key === this.key && !this.unsettled) return
    const moved = key !== this.key
    this.key = key
    this.paths = paths
    this.view = view
    this.unsettled = false
    for (const subscriber of [...this.subscribers.values()]) {
      const ended: string[] = []
      const again: string[] = []
      const started: string[] = []
      const waiting: string[] = []
      for (const [topic, held] of subscriber.topics) {
        if (paths === 'none') {
          if (held.live && !pathless(topic)) held.resync = true
          if (held.live && !held.free && held.judged !== view) {
            held.live = false
            waiting.push(topic)
          }
          continue
        }
        // A retry with the key unmoved asks only about what waits, since every live one was allowed on this StateView
        if (!moved && held.live) continue
        const answer = held.free || paths === 'all' ? 'allow' : this.parts.recheck(subscriber.caller, topic)
        if (answer === 'refuse') {
          ended.push(topic)
        } else if (answer === 'down') {
          this.unsettled = true
          if (held.live) {
            held.live = false
            waiting.push(topic)
          }
        } else {
          if (!held.free && paths === 'ask') held.judged = view
          if (!held.live) {
            held.live = true
            held.resync = false
            again.push(topic)
            if (!held.free) started.push(topic)
          } else if (held.resync) {
            held.resync = false
            again.push(topic)
          }
        }
      }
      for (const topic of ended) this.remove(subscriber, topic)
      if (ended.length > 0) {
        this.signal(subscriber, 'events.ended', ended)
        this.parts.changed(subscriber.caller, 'ended', ended)
      }
      if (waiting.length > 0) this.parts.changed(subscriber.caller, 'waiting', waiting)
      if (started.length > 0) this.parts.changed(subscriber.caller, 'started', started)
      if (again.length > 0) this.resync(subscriber, again)
    }
  }

  // Each event takes one of the subscriber's credits. Past them it is dropped and counted, like every event after it
  // until the subscriber catches up
  private deliver(subscriber: Subscriber, topic: string, path: string | undefined): void {
    if (subscriber.missed === null && subscriber.sent - subscriber.acked >= this.parts.limit(subscriber.plugin, 'eventCredits')) {
      subscriber.missed = new Set()
    }
    if (subscriber.missed !== null) {
      subscriber.missed.add(topic)
      this.parts.dropped(subscriber.caller, 'credits')
      return
    }
    subscriber.sent++
    this.push(subscriber, { v: VERSION, kind: 'event', seq: subscriber.sent, topic, ...(path !== undefined ? { path } : {}) })
  }

  // One events.dropped for these topics, or for a subscriber past its credits the one it gets once it catches up
  private resync(subscriber: Subscriber, topics: string[]): void {
    if (subscriber.missed === null) return this.signal(subscriber, 'events.dropped', topics)
    for (const topic of topics) subscriber.missed.add(topic)
  }

  // A signal takes no credit, so it reaches a subscriber whatever it still holds
  private signal(subscriber: Subscriber, topic: BusSignal, topics: string[]): void {
    this.push(subscriber, { v: VERSION, kind: 'event', topic, topics })
  }

  private push(subscriber: Subscriber, message: unknown): void {
    if (!subscriber.alive()) return
    try {
      subscriber.push(message)
    } catch {}
  }

  private subscriberOf(holder: Holder): Subscriber {
    let subscriber = this.subscribers.get(holder.owner)
    if (subscriber === undefined) {
      subscriber = {
        caller: holder.caller, plugin: holder.plugin, push: holder.push, alive: holder.alive,
        topics: new Map(), sent: 0, acked: 0, missed: null,
      }
      this.subscribers.set(holder.owner, subscriber)
    }
    subscriber.push = holder.push
    return subscriber
  }

  private add(subscriber: Subscriber, topic: string, held: Subscription): void {
    subscriber.topics.set(topic, held)
    let holders = this.byTopic.get(topic)
    if (holders === undefined) {
      holders = new Set()
      this.byTopic.set(topic, holders)
    }
    holders.add(subscriber)
  }

  private remove(subscriber: Subscriber, topic: string): void {
    if (!subscriber.topics.delete(topic)) return
    subscriber.missed?.delete(topic)
    const holders = this.byTopic.get(topic)
    holders?.delete(subscriber)
    if (holders?.size === 0) this.byTopic.delete(topic)
  }
}
