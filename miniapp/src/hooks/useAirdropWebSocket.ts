import { useEffect, useRef } from 'react'
import type { AirdropData } from '../App'

export function useAirdropWebSocket(
  airdropId: string,
  onUpdate: (airdrop: AirdropData) => void
) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const connect = () => {
      // Determine WebSocket URL based on environment
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.host
      const wsUrl = `${protocol}//${host}/ws?airdropId=${airdropId}`
      
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('WebSocket connected')
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'airdrop_update' && data.airdrop) {
            onUpdate(data.airdrop)
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err)
        }
      }

      ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...')
        // Reconnect after 2 seconds
        reconnectTimeoutRef.current = setTimeout(connect, 2000)
      }

      ws.onerror = (error) => {
        console.error('WebSocket error:', error)
        ws.close()
      }
    }

    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [airdropId, onUpdate])
}
