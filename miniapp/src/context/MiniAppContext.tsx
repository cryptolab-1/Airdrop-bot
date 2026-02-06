import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { sdk } from '@farcaster/miniapp-sdk'

type MiniAppUser = {
  fid: number
  username?: string
  displayName?: string
  pfpUrl?: string
}

type MiniAppContextType = {
  isReady: boolean
  user: MiniAppUser | null
  isInMiniApp: boolean
  safeAreaInsets: { top: number; bottom: number; left: number; right: number }
}

const MiniAppContext = createContext<MiniAppContextType>({
  isReady: false,
  user: null,
  isInMiniApp: false,
  safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
})

export function MiniAppProvider({ children }: { children: ReactNode }) {
  const [isReady, setIsReady] = useState(false)
  const [user, setUser] = useState<MiniAppUser | null>(null)
  const [isInMiniApp, setIsInMiniApp] = useState(false)
  const [safeAreaInsets, setSafeAreaInsets] = useState({ top: 0, bottom: 0, left: 0, right: 0 })

  useEffect(() => {
    async function initMiniApp() {
      try {
        // Check if we're running inside a Farcaster client
        const context = sdk.context
        
        if (context?.user) {
          setUser(context.user)
          setIsInMiniApp(true)
          
          if (context.client?.safeAreaInsets) {
            setSafeAreaInsets(context.client.safeAreaInsets)
          }
        }
        
        // Signal that the app is ready
        await sdk.actions.ready()
        setIsReady(true)
      } catch (error) {
        // Not in a mini app context - running standalone
        console.log('Not in mini app context, running standalone')
        setIsReady(true)
        setIsInMiniApp(false)
      }
    }

    initMiniApp()
  }, [])

  return (
    <MiniAppContext.Provider value={{ isReady, user, isInMiniApp, safeAreaInsets }}>
      {children}
    </MiniAppContext.Provider>
  )
}

export function useMiniApp() {
  return useContext(MiniAppContext)
}
