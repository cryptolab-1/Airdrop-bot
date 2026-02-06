import { useMiniApp } from '../context/MiniAppContext'
import { ConnectWallet } from './ConnectWallet'

export function Header() {
  const { user, isInMiniApp } = useMiniApp()

  return (
    <header className="bg-white border-b border-gray-200 px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">💸</span>
          <h1 className="text-lg font-semibold text-gray-900">$TOWNS Airdrop</h1>
        </div>
        
        <div className="flex items-center gap-3">
          {isInMiniApp && user && (
            <div className="flex items-center gap-2">
              {user.pfpUrl && (
                <img 
                  src={user.pfpUrl} 
                  alt={user.displayName || user.username || 'User'} 
                  className="w-8 h-8 rounded-full"
                />
              )}
              <span className="text-sm text-gray-600 hidden sm:inline">
                {user.displayName || user.username || `FID: ${user.fid}`}
              </span>
            </div>
          )}
          <ConnectWallet />
        </div>
      </div>
    </header>
  )
}
