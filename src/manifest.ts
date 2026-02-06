/**
 * Farcaster Mini App manifest generator.
 * See: https://miniapps.farcaster.xyz/docs/specification
 */

export type MiniAppManifest = {
  accountAssociation: {
    header: string
    payload: string
    signature: string
  }
  miniapp: {
    version: '1'
    name: string
    homeUrl: string
    iconUrl: string
    splashImageUrl?: string
    splashBackgroundColor?: string
    webhookUrl?: string
  }
}

/**
 * Generate the mini app manifest.
 * The accountAssociation needs to be pre-generated using your Farcaster custody key.
 * Use the Farcaster developer tools or generate it manually.
 */
export function generateManifest(): MiniAppManifest {
  const baseUrl = process.env.MINIAPP_URL || 'https://airdrop.example.com'
  
  // These values should be set in environment variables
  // Generate accountAssociation using Farcaster developer tools:
  // https://developers.farcaster.xyz/
  const accountAssociation = {
    header: process.env.FARCASTER_MANIFEST_HEADER || '',
    payload: process.env.FARCASTER_MANIFEST_PAYLOAD || '',
    signature: process.env.FARCASTER_MANIFEST_SIGNATURE || '',
  }

  return {
    accountAssociation,
    miniapp: {
      version: '1',
      name: '$TOWNS Airdrop',
      homeUrl: baseUrl,
      iconUrl: `${baseUrl}/icon.png`,
      splashImageUrl: `${baseUrl}/splash.png`,
      splashBackgroundColor: '#7C3AED',
      webhookUrl: `${baseUrl}/api/webhook`,
    },
  }
}

/**
 * Generate the embed meta tag content for sharing.
 */
export function generateEmbedMeta(): object {
  const baseUrl = process.env.MINIAPP_URL || 'https://airdrop.example.com'
  
  return {
    version: '1',
    imageUrl: `${baseUrl}/og-image.png`,
    button: {
      title: '💸 Start',
      action: {
        type: 'launch_frame',
        name: '$TOWNS Airdrop',
        url: baseUrl,
        splashImageUrl: `${baseUrl}/splash.png`,
        splashBackgroundColor: '#7C3AED',
      },
    },
  }
}
