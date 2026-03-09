/**
 * TACo Authentication Module
 * 
 * Auth provider factory and utilities for SIWE-based authentication.
 * Supports EIP-4361 (standard wallets) and EIP-1271 (smart contract wallets).
 */

import { EIP4361AuthProvider } from '@nucypher/taco-auth';

// ── Type Definitions ────────────────────────────────────────────────────────

/**
 * Authentication scheme type.
 */
export type AuthScheme = 'eip4361' | 'eip1271';

/**
 * Auth provider wrapper with metadata.
 */
export interface AuthProviderWrapper {
  /** Authentication scheme */
  scheme: AuthScheme;
  /** The underlying auth provider instance */
  provider: unknown;
  /** Associated wallet address */
  address: string;
}

/**
 * Options for creating an EIP-4361 auth provider.
 */
export interface EIP4361Options {
  /** Domain name for the signing request */
  domain?: string;
  /** URI of the signing request */
  uri?: string;
  /** Optional statement text */
  statement?: string;
}

// ── Auth Provider Factory ───────────────────────────────────────────────────

/**
 * Create an EIP-4361 (SIWE) auth provider.
 * 
 * This is the standard authentication method for TACo, using Sign-In with Ethereum.
 * The auth signature is cached for 2 hours to avoid repeated signature requests.
 * 
 * @param provider - Ethers provider for chain data
 * @param signer - Ethers signer for message signing
 * @param options - Optional SIWE configuration
 * @returns EIP4361AuthProvider instance
 * 
 * @example
 * ```typescript
 * const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
 * const wallet = new ethers.Wallet(privateKey, provider);
 * 
 * const authProvider = createEIP4361AuthProvider(provider, wallet, {
 *   domain: 'myapp.example.com',
 *   uri: 'https://myapp.example.com/auth',
 * });
 * ```
 */
export function createEIP4361AuthProvider(
  provider: any,
  signer: any,
  options: EIP4361Options = {}
): EIP4361AuthProvider {
  const { domain, uri } = options;

  const providerParams = domain || uri ? {
    domain: domain ?? 'localhost',
    uri: uri ?? 'http://localhost',
  } : undefined;

  console.log(`[taco-auth] Creating EIP-4361 auth provider${domain ? ` for domain=${domain}` : ''}`);

  return new EIP4361AuthProvider(provider, signer, providerParams);
}

/**
 * Detect if an address is a smart contract wallet (EIP-1271 compatible).
 * 
 * @param provider - Ethers provider
 * @param address - Wallet address to check
 * @returns Promise resolving to true if the address is a contract
 */
export async function isSmartContractWallet(
  provider: any,
  address: string
): Promise<boolean> {
  try {
    const code = await provider.getCode(address);
    return code !== '0x';
  } catch (error) {
    console.error('[taco-auth] Error checking if address is contract:', error);
    return false;
  }
}

/**
 * Factory function to create the appropriate auth provider based on wallet type.
 * 
 * For regular wallets (EOA), creates an EIP-4361 provider.
 * For smart contract wallets, would create an EIP-1271 provider (not yet implemented).
 * 
 * @param provider - Ethers provider for chain data
 * @param signer - Ethers signer for message signing
 * @param options - Optional auth configuration
 * @returns AuthProviderWrapper with the configured provider
 * 
 * @example
 * ```typescript
 * const wrappedProvider = await createAuthProvider(provider, wallet, {
 *   domain: 'myapp.example.com',
 * });
 * 
 * // Use wrappedProvider.provider with tacoDecrypt
 * ```
 */
export async function createAuthProvider(
  provider: any,
  signer: any,
  options: EIP4361Options = {}
): Promise<AuthProviderWrapper> {
  const address = await signer.getAddress();
  const isContract = await isSmartContractWallet(provider, address);

  if (isContract) {
    // TODO: Implement EIP-1271 support for smart contract wallets
    console.warn('[taco-auth] Smart contract wallet detected. EIP-1271 support coming soon.');
    
    // For now, fall back to EIP-4361 with a warning
    const eip4361Provider = createEIP4361AuthProvider(provider, signer, options);
    
    return {
      scheme: 'eip4361',
      provider: eip4361Provider,
      address,
    };
  }

  // Regular EOA wallet - use standard EIP-4361
  const eip4361Provider = createEIP4361AuthProvider(provider, signer, options);

  return {
    scheme: 'eip4361',
    provider: eip4361Provider,
    address,
  };
}

// ── Auth Signature Helpers ──────────────────────────────────────────────────

/**
 * Get or create an auth signature from an auth provider.
 * 
 * This is useful when you need the raw signature for custom operations.
 * 
 * @param authProvider - The auth provider instance
 * @returns Promise resolving to the auth signature
 */
export async function getAuthSignature(authProvider: unknown): Promise<unknown> {
  // Type guard for EIP4361AuthProvider
  const provider = authProvider as { getOrCreateAuthSignature?: () => Promise<unknown> };
  
  if (!provider.getOrCreateAuthSignature) {
    throw new Error('AuthProvider does not support getOrCreateAuthSignature');
  }

  return provider.getOrCreateAuthSignature();
}

/**
 * Clear cached auth signatures.
 * 
 * Useful for forcing re-authentication.
 * 
 * @param authProvider - The auth provider instance
 */
export async function clearAuthCache(authProvider: unknown): Promise<void> {
  const provider = authProvider as { storage?: { clear?: () => void } };
  
  if (provider.storage?.clear) {
    provider.storage.clear();
    console.log('[taco-auth] Auth cache cleared');
  } else {
    console.warn('[taco-auth] Auth provider does not expose storage for clearing');
  }
}

// ── Session Management ──────────────────────────────────────────────────────

/**
 * Auth session manager for handling reauthentication.
 */
export class AuthSessionManager {
  private sessions: Map<string, {
    provider: unknown;
    expiresAt: number;
  }> = new Map();

  private readonly sessionDurationMs: number = 2 * 60 * 60 * 1000; // 2 hours

  /**
   * Register a new auth session.
   * 
   * @param address - Wallet address
   * @param authProvider - Auth provider instance
   */
  registerSession(address: string, authProvider: unknown): void {
    const expiresAt = Date.now() + this.sessionDurationMs;
    this.sessions.set(address, { provider: authProvider, expiresAt });
    console.log(`[taco-auth] Session registered for ${address}, expires in 2 hours`);
  }

  /**
   * Get a valid auth provider for an address, refreshing if needed.
   * 
   * @param address - Wallet address
   * @returns Auth provider if session is valid, null otherwise
   */
  getSession(address: string): unknown | null {
    const session = this.sessions.get(address);
    
    if (!session) {
      return null;
    }

    if (Date.now() > session.expiresAt) {
      console.log(`[taco-auth] Session expired for ${address}`);
      this.sessions.delete(address);
      return null;
    }

    return session.provider;
  }

  /**
   * Remove a session (e.g., on logout).
   * 
   * @param address - Wallet address
   */
  removeSession(address: string): void {
    this.sessions.delete(address);
    console.log(`[taco-auth] Session removed for ${address}`);
  }

  /**
   * Clear all sessions.
   */
  clearAll(): void {
    this.sessions.clear();
    console.log('[taco-auth] All sessions cleared');
  }

  /**
   * Get list of active session addresses.
   */
  getActiveSessions(): string[] {
    const now = Date.now();
    return Array.from(this.sessions.entries())
      .filter(([, session]) => now <= session.expiresAt)
      .map(([address]) => address);
  }
}

// Export singleton session manager
export const authSessionManager = new AuthSessionManager();
