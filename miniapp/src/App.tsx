import { useState } from 'react'
import { useMiniApp } from './context/MiniAppContext'
import { CreateAirdrop } from './components/CreateAirdrop'
import { AirdropStatus } from './components/AirdropStatus'
import { Header } from './components/Header'

export type AirdropData = {
  id: string
  creatorAddress: string
  totalAmount: string
  amountPerRecipient: string
  recipientCount: number
  status: 'pending' | 'funded' | 'distributing' | 'completed' | 'cancelled'
  participants: string[]
  txHash?: string
}

export default function App() {
  const { isReady, safeAreaInsets } = useMiniApp()
  const [activeAirdrop, setActiveAirdrop] = useState<AirdropData | null>(null)

  if (!isReady) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-pulse-soft">
          <div className="w-12 h-12 rounded-full bg-towns-primary/20 flex items-center justify-center">
            <span className="text-2xl">💸</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div 
      className="flex-1 flex flex-col"
      style={{
        paddingTop: safeAreaInsets.top,
        paddingBottom: safeAreaInsets.bottom,
        paddingLeft: safeAreaInsets.left,
        paddingRight: safeAreaInsets.right,
      }}
    >
      <Header />
      
      <main className="flex-1 p-4">
        {activeAirdrop ? (
          <AirdropStatus 
            airdrop={activeAirdrop} 
            onBack={() => setActiveAirdrop(null)}
            onUpdate={setActiveAirdrop}
          />
        ) : (
          <CreateAirdrop onCreated={setActiveAirdrop} />
        )}
      </main>
    </div>
  )
}
