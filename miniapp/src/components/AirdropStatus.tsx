import { useEffect } from 'react'
import { formatEther } from 'viem'
import type { AirdropData } from '../App'
import { useAirdropWebSocket } from '../hooks/useAirdropWebSocket'
import { ParticipantList } from './ParticipantList'

type Props = {
  airdrop: AirdropData
  onBack: () => void
  onUpdate: (airdrop: AirdropData) => void
}

const STATUS_LABELS: Record<AirdropData['status'], { label: string; color: string }> = {
  pending: { label: 'Waiting for deposit', color: 'text-yellow-600 bg-yellow-50' },
  funded: { label: 'Ready to distribute', color: 'text-blue-600 bg-blue-50' },
  distributing: { label: 'Distributing...', color: 'text-purple-600 bg-purple-50' },
  completed: { label: 'Completed', color: 'text-green-600 bg-green-50' },
  cancelled: { label: 'Cancelled', color: 'text-red-600 bg-red-50' },
}

export function AirdropStatus({ airdrop, onBack, onUpdate }: Props) {
  // Connect to WebSocket for real-time updates
  useAirdropWebSocket(airdrop.id, onUpdate)

  const status = STATUS_LABELS[airdrop.status]
  const canLaunch = airdrop.status === 'funded'
  const isComplete = airdrop.status === 'completed'
  const isDistributing = airdrop.status === 'distributing'

  const handleLaunch = async () => {
    try {
      const res = await fetch(`/api/airdrop/${airdrop.id}/launch`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to launch')
      const updated = await res.json()
      onUpdate(updated)
    } catch (err) {
      console.error('Failed to launch airdrop:', err)
    }
  }

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel this airdrop?')) return
    try {
      const res = await fetch(`/api/airdrop/${airdrop.id}/cancel`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to cancel')
      const updated = await res.json()
      onUpdate(updated)
    } catch (err) {
      console.error('Failed to cancel airdrop:', err)
    }
  }

  return (
    <div className="animate-fade-in space-y-4">
      {/* Back Button */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      {/* Status Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Airdrop Status</h2>
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${status.color}`}>
            {status.label}
          </span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-sm text-gray-500">Total Amount</div>
            <div className="text-lg font-semibold text-gray-900">
              {formatEther(BigInt(airdrop.totalAmount))} $TOWNS
            </div>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-sm text-gray-500">Per Recipient</div>
            <div className="text-lg font-semibold text-gray-900">
              {formatEther(BigInt(airdrop.amountPerRecipient))} $TOWNS
            </div>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg col-span-2">
            <div className="text-sm text-gray-500">Recipients</div>
            <div className="text-lg font-semibold text-gray-900">
              {airdrop.participants.length} / {airdrop.recipientCount}
            </div>
          </div>
        </div>

        {/* Transaction Hash */}
        {airdrop.txHash && (
          <div className="mb-6 p-3 bg-green-50 border border-green-200 rounded-lg">
            <div className="text-sm text-green-700 mb-1">Transaction</div>
            <a
              href={`https://basescan.org/tx/${airdrop.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-green-800 font-mono hover:underline break-all"
            >
              {airdrop.txHash}
            </a>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          {canLaunch && (
            <button
              onClick={handleLaunch}
              className="flex-1 py-3 px-4 bg-towns-accent text-white rounded-lg font-medium hover:bg-towns-accent/90 transition-colors"
            >
              🚀 Launch Airdrop
            </button>
          )}
          
          {(airdrop.status === 'pending' || airdrop.status === 'funded') && (
            <button
              onClick={handleCancel}
              className="py-3 px-4 border border-red-300 text-red-600 rounded-lg font-medium hover:bg-red-50 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>

        {isDistributing && (
          <div className="mt-4 flex items-center justify-center gap-2 text-purple-600">
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span>Distribution in progress...</span>
          </div>
        )}

        {isComplete && (
          <div className="mt-4 text-center text-green-600 font-medium">
            ✅ Airdrop completed successfully!
          </div>
        )}
      </div>

      {/* Participants */}
      <ParticipantList participants={airdrop.participants} />
    </div>
  )
}
