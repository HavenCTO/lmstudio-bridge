/**
 * TACo Client Initialization Module
 * 
 * Handles TACo SDK initialization, ritual verification, and provider management.
 * Target network: TACo DEVNET (lynx)
 * Default ritual: 27 (Open Ritual, 2-of-3 cohort)
 */

import { Domain, domains, initialize } from '@nucypher/taco';
import { DkgPublicKey } from '@nucypher/nucypher-core';

// TACo Network Configuration
export interface TacoNetworkConfig {
  /** TACo domain/network name */
  domain: Domain;
  /** RPC URL for the blockchain network */
  rpcUrl: string;
  /** Ritual ID for the DKG ritual to use */
  ritualId: number;
  /** Optional custom Porter URIs */
  porterUris?: string[];
}

// Default configuration for TACo DEVNET
export const DEVNET_CONFIG: TacoNetworkConfig = {
  domain: domains.DEVNET,
  rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  ritualId: 27, // Open Ritual, 2-of-3 cohort
};

/**
 * TACoClient manages the TACo SDK lifecycle including initialization,
 * ritual verification, and provider management.
 */
export class TacoClient {
  private provider: any | null = null;
  private signer: any | null = null;
  private dkgPublicKey: DkgPublicKey | null = null;
  private initialized: boolean = false;

  constructor(
    private config: TacoNetworkConfig = DEVNET_CONFIG
  ) {}

  /**
   * Initialize the TACo client with an optional signer.
   * This sets up the SDK and fetches the DKG public key for the specified ritual.
   * 
   * @param signer - Optional ethers signer for encryption operations
   * @returns Promise resolving when initialization is complete
   */
  async initialize(signer?: any): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log(`[taco-client] Initializing TACo client for domain=${this.config.domain}, ritualId=${this.config.ritualId}`);

    try {
      // Initialize the TACo SDK
      await initialize();
      console.log('[taco-client] TACo SDK initialized');

      // Dynamic import for ethers v5
      const ethersModule = await import("ethers");
      const ethers = (ethersModule as any).ethers || (ethersModule as any).default;

      // Create provider
      this.provider = new ethers.providers.JsonRpcProvider(this.config.rpcUrl);
      
      // Test provider connectivity
      const blockNumber = await this.provider.getBlockNumber();
      console.log(`[taco-client] Connected to RPC at block ${blockNumber}`);

      // Set signer if provided
      if (signer) {
        this.signer = signer;
        const address = await signer.getAddress();
        console.log(`[taco-client] Signer configured: ${address}`);
      }

      // Fetch and cache the DKG public key for the ritual
      await this.fetchDkgPublicKey();

      this.initialized = true;
      console.log('[taco-client] TACo client ready');
    } catch (error) {
      console.error('[taco-client] Initialization failed:', error);
      throw new Error(`TACo client initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch the DKG public key for the configured ritual.
   * This is required for encryption operations.
   */
  async fetchDkgPublicKey(): Promise<DkgPublicKey> {
    if (this.dkgPublicKey && this.initialized) {
      return this.dkgPublicKey;
    }

    if (!this.provider) {
      throw new Error('TACo client not initialized. Call initialize() first.');
    }

    console.log(`[taco-client] Fetching DKG public key for ritual ${this.config.ritualId}...`);

    try {
      // Use the taco SDK's built-in method to get the active ritual's public key
      const tacoModule = await import('@nucypher/taco');
      // @ts-ignore - DkgClient may be available at runtime
      const { DkgClient } = tacoModule;
      
      if (!DkgClient) {
        throw new Error('DkgClient not available in TACo SDK. Ensure you have a compatible version.');
      }
      
      const ritual = await DkgClient.getActiveRitual(this.provider, this.config.domain, this.config.ritualId);
      this.dkgPublicKey = ritual.dkgPublicKey;
      
      console.log(`[taco-client] DKG public key fetched successfully`);
      return this.dkgPublicKey!;
    } catch (error) {
      console.error('[taco-client] Failed to fetch DKG public key:', error);
      throw new Error(`Failed to fetch DKG public key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Verify that the configured ritual exists and is active.
   * 
   * @returns Promise resolving to ritual status information
   */
  async verifyRitual(): Promise<{
    ritualId: number;
    isActive: boolean;
    threshold: { k: number; l: number };
    dkgPublicKey: DkgPublicKey | null;
  }> {
    if (!this.provider) {
      throw new Error('TACo client not initialized. Call initialize() first.');
    }

    console.log(`[taco-client] Verifying ritual ${this.config.ritualId}...`);

    try {
      const tacoModule = await import('@nucypher/taco');
      // @ts-ignore - DkgClient may be available at runtime
      const { DkgClient } = tacoModule;
      
      if (!DkgClient) {
        throw new Error('DkgClient not available in TACo SDK.');
      }
      
      const ritual = await DkgClient.getActiveRitual(this.provider, this.config.domain, this.config.ritualId);
      
      // Get threshold info (k, l) from the ritual
      const threshold = {
        k: ritual.threshold,
        l: ritual.sharesNum,
      };

      console.log(`[taco-client] Ritual ${this.config.ritualId} verified: threshold=${threshold.k}/${threshold.l}`);

      return {
        ritualId: this.config.ritualId,
        isActive: true,
        threshold,
        dkgPublicKey: ritual.dkgPublicKey,
      };
    } catch (error) {
      console.warn(`[taco-client] Ritual ${this.config.ritualId} verification failed:`, error);
      return {
        ritualId: this.config.ritualId,
        isActive: false,
        threshold: { k: 0, l: 0 },
        dkgPublicKey: null,
      };
    }
  }

  /**
   * Get the configured domain.
   */
  getDomain(): Domain {
    return this.config.domain;
  }

  /**
   * Get the configured ritual ID.
   */
  getRitualId(): number {
    return this.config.ritualId;
  }

  /**
   * Get the ethers provider.
   */
  getProvider(): any {
    if (!this.provider) {
      throw new Error('TACo client not initialized. Call initialize() first.');
    }
    return this.provider;
  }

  /**
   * Get the configured signer.
   */
  getSigner(): any | null {
    return this.signer;
  }

  /**
   * Get the cached DKG public key.
   */
  getDkgPublicKey(): DkgPublicKey | null {
    return this.dkgPublicKey;
  }

  /**
   * Check if the client is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Disconnect and clean up resources.
   */
  async disconnect(): Promise<void> {
    if (this.provider) {
      // Note: JsonRpcProvider doesn't have a destroy method in v5
      // but we can set it to null to release references
      this.provider = null;
    }
    this.signer = null;
    this.dkgPublicKey = null;
    this.initialized = false;
    console.log('[taco-client] Disconnected');
  }
}

/**
 * Factory function to create and initialize a TACoClient.
 * 
 * @param config - Optional TACo network configuration
 * @param privateKey - Optional private key for creating a signer
 * @returns Promise resolving to an initialized TacoClient instance
 */
export async function createTacoClient(
  config?: Partial<TacoNetworkConfig>,
  privateKey?: string
): Promise<TacoClient> {
  const fullConfig: TacoNetworkConfig = {
    ...DEVNET_CONFIG,
    ...config,
  };

  const client = new TacoClient(fullConfig);

  let signer: any | undefined;
  if (privateKey) {
    // Dynamic import for ethers v5
    const ethersModule = await import("ethers");
    const ethers = (ethersModule as any).ethers || (ethersModule as any).default;
    const wallet = new ethers.Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
    // Lazy init provider for connection
    await client.initialize();
    signer = wallet.connect(client.getProvider());
  }

  await client.initialize(signer);
  return client;
}
