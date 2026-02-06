import { useState } from 'react'
import { useAccount, useWriteContract } from 'wagmi'
import { TOWNS_ADDRESS, ERC20_ABI } from '../config/wagmi'
import type { AirdropData } from '../App'

type CreateAirdropParams = {
  mode: 'fixed' | 'react'
  totalAmount: string
  botAddress: `0x${string}`
}

export function useCreateAirdrop() {
  const { address } = useAccount()
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  
  const { writeContractAsync } = useWriteContract()

  const createAirdrop = async (params: CreateAirdropParams): Promise<AirdropData> => {
    if (!address) throw new Error('Wallet not connected')
    
    setIsPending(true)
    setError(null)
    
    try {
      // Step 1: Create airdrop record on backend
      const createRes = await fetch('/api/airdrop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: params.mode,
          totalAmount: params.totalAmount,
          creatorAddress: address,
        }),
      })
      
      if (!createRes.ok) {
        const err = await createRes.json()
        throw new Error(err.error || 'Failed to create airdrop')
      }
      
      const airdrop: AirdropData = await createRes.json()
      
      // Step 2: Send deposit transaction to bot
      const txHash = await writeContractAsync({
        address: TOWNS_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [params.botAddress, BigInt(params.totalAmount)],
      })
      
      // Step 3: Confirm deposit with backend
      const confirmRes = await fetch(`/api/airdrop/${airdrop.id}/confirm-deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash }),
      })
      
      if (!confirmRes.ok) {
        const err = await confirmRes.json()
        throw new Error(err.error || 'Failed to confirm deposit')
      }
      
      const confirmedAirdrop: AirdropData = await confirmRes.json()
      return confirmedAirdrop
      
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error')
      setError(error)
      throw error
    } finally {
      setIsPending(false)
    }
  }

  return { createAirdrop, isPending, error }
}
