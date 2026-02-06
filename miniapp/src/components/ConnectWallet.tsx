import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { sdk } from '@farcaster/miniapp-sdk'
import { useMiniApp } from '../context/MiniAppContext'

export function ConnectWallet() {
  const { address, isConnected, isConnecting } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const { isInMiniApp } = useMiniApp()

  const handleConnect = async () => {
    if (isInMiniApp) {
      // Use Farcaster SDK wallet provider
      try {
        const provider = await sdk.wallet.getEthereumProvider()
        if (!provider) {
          console.error('No provider available')
          return
        }
        const accounts = await provider.request({ method: 'eth_requestAccounts' })
        if (accounts.length > 0) {
          // Wagmi will pick up the connected account
          const injectedConnector = connectors.find(c => c.id === 'injected')
          if (injectedConnector) {
            connect({ connector: injectedConnector })
          }
        }
      } catch (err) {
        console.error('Failed to connect wallet:', err)
      }
    } else {
      // Use first available connector (for standalone testing)
      const connector = connectors[0]
      if (connector) {
        connect({ connector })
      }
    }
  }

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-3 bg-white rounded-lg border border-gray-200 px-4 py-2">
        <div className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-sm font-mono text-gray-700">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        <button
          onClick={() => disconnect()}
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={handleConnect}
      disabled={isConnecting}
      className="bg-towns-primary text-white px-4 py-2 rounded-lg font-medium hover:bg-towns-primary/90 transition-colors disabled:opacity-50"
    >
      {isConnecting ? 'Connecting...' : 'Connect Wallet'}
    </button>
  )
}
