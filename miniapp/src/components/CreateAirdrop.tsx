import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { parseEther, formatEther } from 'viem'
import { useAccount } from 'wagmi'
import type { AirdropData } from '../App'
import { useCreateAirdrop } from '../hooks/useCreateAirdrop'

type Props = {
  onCreated: (airdrop: AirdropData) => void
}

export function CreateAirdrop({ onCreated }: Props) {
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<'fixed' | 'react'>('fixed')
  const { address, isConnected } = useAccount()
  
  const { data: holdersData, isLoading: loadingHolders } = useQuery({
    queryKey: ['holders'],
    queryFn: async () => {
      const res = await fetch('/api/holders')
      if (!res.ok) throw new Error('Failed to fetch holders')
      return res.json() as Promise<{ count: number; botAddress: string }>
    },
  })

  const { createAirdrop, isPending, error } = useCreateAirdrop()

  const holderCount = holdersData?.count ?? 0
  const botAddress = holdersData?.botAddress
  const amountNum = parseFloat(amount) || 0
  const amountPerPerson = holderCount > 0 ? amountNum / holderCount : 0
  const isValidAmount = amountNum > 0 && amountNum >= holderCount * 0.000001 // Min amount per person

  const handleCreate = async () => {
    if (!isValidAmount || !address || !botAddress) return
    
    try {
      const totalRaw = parseEther(amount)
      const airdrop = await createAirdrop({
        mode,
        totalAmount: totalRaw.toString(),
        botAddress: botAddress as `0x${string}`,
      })
      onCreated(airdrop)
    } catch (err) {
      console.error('Failed to create airdrop:', err)
    }
  }

  return (
    <div className="animate-fade-in space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Create Airdrop</h2>
        
        {/* Mode Selection */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Distribution Mode
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMode('fixed')}
              className={`p-3 rounded-lg border-2 transition-all ${
                mode === 'fixed'
                  ? 'border-towns-primary bg-towns-primary/5 text-towns-primary'
                  : 'border-gray-200 hover:border-gray-300 text-gray-600'
              }`}
            >
              <div className="font-medium">Fixed Drop</div>
              <div className="text-xs mt-1 opacity-75">
                All NFT holders receive tokens
              </div>
            </button>
            <button
              onClick={() => setMode('react')}
              className={`p-3 rounded-lg border-2 transition-all ${
                mode === 'react'
                  ? 'border-towns-primary bg-towns-primary/5 text-towns-primary'
                  : 'border-gray-200 hover:border-gray-300 text-gray-600'
              }`}
            >
              <div className="font-medium">React Drop</div>
              <div className="text-xs mt-1 opacity-75">
                Users join by clicking
              </div>
            </button>
          </div>
        </div>

        {/* Holder Count */}
        <div className="mb-6 p-4 bg-gray-50 rounded-lg">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Eligible Recipients</span>
            {loadingHolders ? (
              <span className="text-sm text-gray-400">Loading...</span>
            ) : (
              <span className="text-lg font-semibold text-gray-900">
                {holderCount} holders
              </span>
            )}
          </div>
          {mode === 'react' && (
            <p className="text-xs text-gray-500 mt-2">
              In react mode, only users who join will receive tokens.
            </p>
          )}
        </div>

        {/* Amount Input */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Total Amount ($TOWNS)
          </label>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              min="0"
              step="any"
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-towns-primary focus:border-transparent text-lg"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">
              $TOWNS
            </span>
          </div>
          {isValidAmount && mode === 'fixed' && holderCount > 0 && (
            <p className="mt-2 text-sm text-gray-600">
              ≈ <span className="font-medium">{amountPerPerson.toFixed(6)}</span> $TOWNS per holder
            </p>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error.message}
          </div>
        )}

        {/* Create Button */}
        <button
          onClick={handleCreate}
          disabled={!isValidAmount || isPending || !isConnected}
          className={`w-full py-3 px-4 rounded-lg font-medium transition-all ${
            isValidAmount && isConnected && !isPending
              ? 'bg-towns-primary text-white hover:bg-towns-primary/90'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          {isPending ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Creating...
            </span>
          ) : !isConnected ? (
            'Connect Wallet'
          ) : (
            `Create ${mode === 'fixed' ? 'Fixed' : 'React'} Airdrop`
          )}
        </button>
      </div>

      {/* Info Card */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <h3 className="font-medium text-blue-900 mb-2">How it works</h3>
        <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
          <li>Set your total airdrop amount</li>
          <li>Sign one transaction to deposit to the bot</li>
          {mode === 'react' && <li>Wait for users to join</li>}
          <li>{mode === 'fixed' ? 'Bot distributes to all holders' : 'Launch when ready to distribute'}</li>
        </ol>
      </div>
    </div>
  )
}
