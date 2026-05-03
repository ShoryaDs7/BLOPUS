/**
 * ApiDM — Twitter API v2 DM adapter. Drop-in replacement for MCPBrowserDM.
 * No Playwright, no browser, no suspension risk — official API only.
 * Requires "Read and write and Direct message" OAuth 1.0a permission on the app.
 */

import { TwitterApi } from 'twitter-api-v2'
import { blockLeak } from '../adapters/security/SecurityShield'

export interface DmConversation {
  handle: string
  lastMessage: string
  isUnread: boolean
  userId?: string
}

export class ApiDM {
  private client: TwitterApi

  constructor(private myUserId: string) {
    const apiKey            = process.env.TWITTER_API_KEY
    const apiSecret         = process.env.TWITTER_API_SECRET
    const accessToken       = process.env.TWITTER_ACCESS_TOKEN
    const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET

    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      throw new Error('Missing Twitter credentials for ApiDM')
    }

    this.client = new TwitterApi({
      appKey: apiKey, appSecret: apiSecret,
      accessToken, accessSecret: accessTokenSecret,
    })
    console.log(`[ApiDM] using access token: ...${accessToken.slice(-6)}`)
  }

  // ── Send ─────────────────────────────────────────────────────────────────────

  async send(handle: string, text: string): Promise<boolean> {
    if (!await blockLeak(text, `dm to @${handle}`)) return false
    try {
      const h = handle.replace(/^@/, '')
      const userResp = await this.client.v2.userByUsername(h)
      if (!userResp.data?.id) { console.log(`[ApiDM] @${h} not found`); return false }
      await (this.client.v2 as any).sendDmToParticipant(userResp.data.id, { text })
      console.log(`[ApiDM] DM sent to @${h} ✓`)
      return true
    } catch (err) {
      console.log(`[ApiDM] send() error: ${err}`)
      return false
    }
  }

  // ── Read inbox ────────────────────────────────────────────────────────────────

  async readInbox(): Promise<DmConversation[]> {
    try {
      const resp = await (this.client.v2 as any).listDmEvents({
        max_results: 50,
        'dm_event.fields': 'id,text,event_type,dm_conversation_id,created_at,sender_id',
        expansions:        'sender_id',
        'user.fields':     'username',
      })
      // twitter-api-v2 returns a paginator — real data is at ._realData, accessed via .data
      const events: any[] = (resp as any)._realData?.data ?? resp.data?.data ?? []
      console.log(`[ApiDM] events from API: ${events.length}`)
      const users: any[]  = resp.data?.includes?.users ?? []
      const userMap = new Map<string, string>(users.map((u: any) => [u.id, u.username]))

      // Events come newest-first. One entry per conversation — the most recent message.
      const seen = new Set<string>()
      const convos: DmConversation[] = []

      for (const event of events) {
        if (event.event_type !== 'MessageCreate') continue
        const convId = event.dm_conversation_id ?? ''
        if (seen.has(convId)) continue
        seen.add(convId)

        const senderId   = event.sender_id ?? ''
        const senderIsMe = senderId === this.myUserId
        // Other user's ID: from sender if they sent, else derive from 1-on-1 conv ID
        const otherUserId = senderIsMe ? this.extractOtherUserId(convId) : senderId
        const handle      = userMap.get(otherUserId) ?? otherUserId

        convos.push({
          handle,
          lastMessage: event.text ?? '',
          isUnread: !senderIsMe,   // unread = last message is from them, not us
          userId: otherUserId,
        })
      }

      console.log(`[ApiDM] readInbox: ${convos.length} conversations, ${convos.filter(c => c.isUnread).length} unread`)
      return convos
    } catch (err: any) {
      console.log(`[ApiDM] readInbox() error ${err?.code ?? err?.status ?? ''}: ${err}`)
      if (err?.code === 403 || err?.status === 403) {
        console.log(`[ApiDM] 403 — app missing "Read and write and Direct message" permission. Go to developer.twitter.com → your app → Settings → change permission, then regenerate access token.`)
      }
      return []
    }
  }

  // ── Read inbox + thread (one logical call, two API requests) ──────────────────

  async readInboxAndThread(
    handle: string,
    userId?: string,
  ): Promise<{ convos: DmConversation[], thread: Array<{ by: 'me' | 'them', text: string }>, resolvedHandle: string }> {
    const convos = await this.readInbox()

    let targetUserId  = userId
    let resolvedHandle = handle.replace(/^@/, '')

    // Resolve userId ↔ handle whichever is missing
    if (!targetUserId) {
      try {
        const r = await this.client.v2.userByUsername(resolvedHandle)
        if (r.data?.id) targetUserId = r.data.id
      } catch {}
    } else {
      try {
        const r = await this.client.v2.user(targetUserId, { 'user.fields': ['username'] } as any)
        if (r.data?.username) resolvedHandle = r.data.username.toLowerCase()
      } catch {}
    }

    if (!targetUserId) return { convos, thread: [], resolvedHandle }

    try {
      const resp = await (this.client.v2 as any).listDmEventsWithParticipant(targetUserId, {
        max_results: 20,
        'dm_event.fields': 'id,text,event_type,sender_id,created_at',
      })

      const thread = ((resp.data?.data ?? []) as any[])
        .filter((e: any) => e.event_type === 'MessageCreate')
        .reverse()   // API returns newest-first; we want oldest-first for prompt context
        .map((e: any) => ({
          by:   e.sender_id === this.myUserId ? 'me' as const : 'them' as const,
          text: e.text ?? '',
        }))

      console.log(`[ApiDM] readInboxAndThread: ${thread.length} messages from @${resolvedHandle}`)
      return { convos, thread, resolvedHandle }
    } catch (err) {
      console.log(`[ApiDM] readInboxAndThread error: ${err}`)
      return { convos, thread: [], resolvedHandle }
    }
  }

  // ── Resolve userId → handle (reliable: official API, not OCR or URL redirect) ─

  async resolveUserId(userId: string): Promise<string | null> {
    try {
      const resp = await this.client.v2.user(userId, { 'user.fields': ['username'] } as any)
      return resp.data?.username?.toLowerCase() ?? null
    } catch {
      return null
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /** 1-on-1 DM conversation IDs are "<smallerId>-<largerId>" numerically. */
  private extractOtherUserId(convId: string): string {
    return convId.split('-').find(p => p !== this.myUserId) ?? ''
  }
}
