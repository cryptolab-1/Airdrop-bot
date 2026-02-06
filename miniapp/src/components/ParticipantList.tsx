type Props = {
  participants: string[]
}

export function ParticipantList({ participants }: Props) {
  if (participants.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Participants</h3>
        <div className="text-center py-8 text-gray-500">
          <div className="text-3xl mb-2">👋</div>
          <p>No participants yet</p>
          <p className="text-sm mt-1">Waiting for users to join...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Participants ({participants.length})
      </h3>
      
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {participants.map((address, index) => (
          <div
            key={address}
            className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg animate-fade-in"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-towns-primary to-towns-secondary flex items-center justify-center text-white text-sm font-medium">
              {index + 1}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono text-gray-700 truncate">
                {address.slice(0, 6)}...{address.slice(-4)}
              </p>
            </div>
            <a
              href={`https://basescan.org/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}
