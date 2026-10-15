// useSSE — 管理 SSE 会话生命周期

import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  ConnectRequest, ConnectResponse, AudioChunk, AudioUploadResponse,
  ServerEvent, StateUpdateRequest, RecordMode,
} from '@vow/shared/types'
import { SSE_PING_MS } from '@vow/shared/constants'

interface UseSSEOptions {
  deviceName?: string
  mode: RecordMode
  /** output_audio 事件回调 */
  onOutputAudio?: (base64Data: string, sampleRate: number) => void
}

interface UseSSEReturn {
  sessionId: string | null
  connected: boolean
  connecting: boolean
  lastEvent: ServerEvent | null
  connect: () => Promise<void>
  disconnect: () => void
  uploadAudio: (data: string, sampleRate: number, sequence: number) => Promise<number>
  updateState: (update: StateUpdateRequest) => Promise<void>
}

export function useSSE({ deviceName, mode, onOutputAudio }: UseSSEOptions): UseSSEReturn {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null)

  const eventSourceRef = useRef<EventSource | null>(null)
  const onOutputAudioRef = useRef(onOutputAudio)
  onOutputAudioRef.current = onOutputAudio

  const cleanupStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  const disconnect = useCallback(() => {
    cleanupStream()
    setSessionId(null)
    setConnected(false)
    setLastEvent(null)
  }, [cleanupStream])

  const connect = useCallback(async () => {
    setConnecting(true)
    try {
      const body: ConnectRequest = { deviceName, mode }
      const sessResp = await fetch('/api/sse/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!sessResp.ok) {
        throw new Error(`Session creation failed: ${sessResp.status}`)
      }
      const sessData: ConnectResponse = await sessResp.json()
      const sid = sessData.sessionId
      setSessionId(sid)

      const es = new EventSource(`/api/sse/stream?sessionId=${sid}`)
      eventSourceRef.current = es

      es.addEventListener('message', (evt) => {
        try {
          const event: ServerEvent = JSON.parse(evt.data)
          setLastEvent(event)

          if (event.type === 'connected') {
            setConnected(true)
            setConnecting(false)
          }
          if (event.type === 'error') {
            setConnected(false)
          }
          if (event.type === 'output_audio') {
            const p = event.payload as { data: string; sampleRate: number } | undefined
            if (p && onOutputAudioRef.current) {
              onOutputAudioRef.current(p.data, p.sampleRate)
            }
          }
        } catch { /* ignore */ }
      })

      es.addEventListener('error', () => {
        setConnected(false)
      })

    } catch (err) {
      console.error('[useSSE] connect error:', err)
      setConnecting(false)
    }
  }, [deviceName, mode])

  const uploadAudio = useCallback(async (data: string, sampleRate: number, sequence: number) => {
    if (!sessionId) throw new Error('No session')
    const chunk: AudioChunk = { sessionId, data, sampleRate, timestamp: Date.now(), sequence }
    const resp = await fetch('/api/sse/audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    })
    if (!resp.ok) throw new Error(`Audio upload failed: ${resp.status}`)
    const result: AudioUploadResponse = await resp.json()
    return result.received
  }, [sessionId])

  const updateState = useCallback(async (update: StateUpdateRequest) => {
    if (!sessionId) throw new Error('No session')
    await fetch(`/api/sse/state?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    })
  }, [sessionId])

  useEffect(() => {
    return () => { cleanupStream() }
  }, [cleanupStream])

  // 保活 ping：每 15s 上报活跃，页面回到前台立即补一次。
  // 服务端以 SSE_SESSION_TTL_MS 回收超时会话——代理后断连检测不可靠时的兜底。
  // ping 404 = 会话已被服务端回收（TTL/重启），自动重建
  useEffect(() => {
    if (!sessionId) return
    const ping = async () => {
      try {
        const r = await fetch(`/api/sse/ping?sessionId=${sessionId}`, { method: 'POST' })
        if (r.status === 404) {
          cleanupStream()
          void connect()
        }
      } catch { /* 网络抖动，忽略 */ }
    }
    const timer = setInterval(ping, SSE_PING_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ping()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sessionId, connect, cleanupStream])

  return { sessionId, connected, connecting, lastEvent, connect, disconnect, uploadAudio, updateState }
}