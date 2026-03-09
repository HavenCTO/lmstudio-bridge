/**
 * TACo Encryption Module
 * 
 * Client-side encryption and decryption using TACo SDK.
 * Handles messageKit creation, JSON wrapping, and IPFS integration.
 */

import { DkgPublicKey, ThresholdMessageKit } from '@nucypher/nucypher-core';
import { TacoClient } from './taco-client';

// ── Type Definitions ────────────────────────────────────────────────────────

/**
 * Encrypted payload wrapper for IPFS storage.
 * Contains the encrypted messageKit along with metadata for decryption.
 */
export interface EncryptedPayload {
  /** Schema version for backwards compatibility */
  schemaVersion: string;
  /** TACo domain/network used for encryption */
  tacoDomain: string;
  /** Ritual ID used for encryption */
  ritualId: number;
  /** Serialized ThresholdMessageKit */
  messageKit: Uint8Array;
  /** Access control condition used for encryption (ConditionProps) */
  condition: Record<string, unknown>;
  /** Optional context variables for conditional decryption */
  contextVariables?: Record<string, unknown>;
  /** Original plaintext size (for progress indicators) */
  originalSize?: number;
  /** Timestamp of encryption */
  timestamp: number;
}

/**
 * Decryption result with metadata.
 */
export interface DecryptionResult {
  /** Decrypted plaintext as string */
  plaintext: string;
  /** Original plaintext size */
  originalSize: number;
  /** Decryption timestamp */
  timestamp: number;
  /** Whether decryption was successful */
  success: true;
}

/**
 * Encryption options.
 */
export interface EncryptOptions {
  /** Auth signer for encryption authorization */
  authSigner?: any;
  /** Custom Porter URIs (optional) */
  porterUris?: string[];
}

/**
 * Decryption options.
 */
export interface DecryptOptions {
  /** Auth provider for decryption authorization */
  authProvider: unknown; // Will be EIP4361AuthProvider or similar
  /** Custom Porter URIs (optional) */
  porterUris?: string[];
}

// ── Serialization Helpers ───────────────────────────────────────────────────

/**
 * Serialize a ThresholdMessageKit to bytes.
 */
export function serializeMessageKit(messageKit: ThresholdMessageKit): Uint8Array {
  return messageKit.toBytes();
}

/**
 * Deserialize bytes back to a ThresholdMessageKit.
 */
export function deserializeMessageKit(bytes: Uint8Array): ThresholdMessageKit {
  return ThresholdMessageKit.fromBytes(bytes);
}

/**
 * Convert EncryptedPayload to JSON string for IPFS storage.
 */
export function payloadToJson(payload: EncryptedPayload): string {
  return JSON.stringify({
    ...payload,
    messageKit: Array.from(payload.messageKit),
  });
}

/**
 * Parse EncryptedPayload from JSON string.
 */
export function jsonToPayload(json: string): EncryptedPayload {
  const parsed = JSON.parse(json);
  return {
    ...parsed,
    messageKit: new Uint8Array(parsed.messageKit),
  };
}

// ── Encryption Functions ────────────────────────────────────────────────────

/**
 * Encrypt a message using TACo with DAO token holder conditions.
 * 
 * @param tacoClient - Initialized TACoClient instance
 * @param plaintext - The message to encrypt
 * @param condition - Access control condition for decryption (ConditionProps)
 * @param options - Optional encryption configuration
 * @returns EncryptedPayload ready for IPFS storage
 * 
 * @example
 * ```typescript
 * const client = await createTacoClient(config, privateKey);
 * const condition = createDaoTokenCondition({
 *   type: 'ERC20',
 *   contractAddress: '0x...',
 *   chain: 'sepolia',
 *   minimumBalance: '1000000000000000000'
 * });
 * 
 * const encrypted = await tacoEncrypt(client, 'Secret message', condition);
 * // Store encrypted in IPFS...
 * ```
 */
export async function tacoEncrypt(
  tacoClient: TacoClient,
  plaintext: string | Uint8Array,
  condition: Record<string, unknown>,
  options: EncryptOptions = {}
): Promise<EncryptedPayload> {
  const { authSigner, porterUris } = options;

  if (!tacoClient.isInitialized()) {
    throw new Error('TacoClient not initialized. Call initialize() first.');
  }

  const provider = tacoClient.getProvider();
  const domain = tacoClient.getDomain();
  const ritualId = tacoClient.getRitualId();

  console.log(`[taco-encrypt] Encrypting message (domain=${domain}, ritual=${ritualId})`);

  try {
    // Dynamic import for TACo SDK
    const tacoModule = await import('@nucypher/taco');
    const { encrypt } = tacoModule;
    
    // Dynamic import for Condition class - try multiple paths
    let TacoCondition: any;
    try {
      // @ts-ignore - dynamic path may not resolve in static analysis
      const conditionModule = await import('@nucypher/taco/conditions/condition');
      TacoCondition = conditionModule.Condition;
    } catch {
      // Fallback: Condition might be on main module
      TacoCondition = (tacoModule as any).Condition;
    }

    if (!TacoCondition) {
      throw new Error('Condition class not available in TACo SDK.');
    }

    // Use provided signer or fall back to client's signer
    const signer = authSigner || tacoClient.getSigner();
    
    if (!signer) {
      throw new Error('No auth signer available. Provide authSigner or configure TacoClient with a signer.');
    }

    // Convert condition props to Condition object
    const conditionObj = new TacoCondition(condition);

    // Encrypt the message
    const messageKit = await encrypt(provider, domain, plaintext, conditionObj, ritualId, signer);

    console.log(`[taco-encrypt] Message encrypted successfully`);

    // Build the encrypted payload wrapper
    const payload: EncryptedPayload = {
      schemaVersion: 'taco-v1',
      tacoDomain: domain,
      ritualId,
      messageKit: serializeMessageKit(messageKit),
      condition: conditionObj.toObj(),
      timestamp: Date.now(),
      originalSize: typeof plaintext === 'string' 
        ? Buffer.byteLength(plaintext, 'utf-8') 
        : plaintext.length,
    };

    return payload;
  } catch (error) {
    console.error('[taco-encrypt] Encryption failed:', error);
    throw new Error(`Encryption failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Encrypt and upload to IPFS (if IPFS utilities are available).
 * 
 * @param tacoClient - Initialized TACoClient instance
 * @param plaintext - The message to encrypt
 * @param condition - Access control condition for decryption (ConditionProps)
 * @param ipfsAddFn - Optional IPFS add function
 * @returns Object with encrypted payload and optional IPFS CID
 */
export async function tacoEncryptToIpfs(
  tacoClient: TacoClient,
  plaintext: string | Uint8Array,
  condition: Record<string, unknown>,
  ipfsAddFn?: (data: string) => Promise<string>
): Promise<{ payload: EncryptedPayload; cid?: string }> {
  const payload = await tacoEncrypt(tacoClient, plaintext, condition);
  
  let cid: string | undefined;
  
  if (ipfsAddFn) {
    const json = payloadToJson(payload);
    cid = await ipfsAddFn(json);
    console.log(`[taco-encrypt] Payload uploaded to IPFS: ${cid}`);
  }

  return { payload, cid };
}

// ── Decryption Functions ────────────────────────────────────────────────────

/**
 * Decrypt a message using TACo.
 * 
 * @param tacoClient - Initialized TACoClient instance
 * @param payload - The encrypted payload to decrypt
 * @param options - Decryption options including auth provider
 * @returns DecryptionResult with the plaintext
 * 
 * @example
 * ```typescript
 * const client = await createTacoClient(config);
 * const payload = jsonToPayload(encryptedJson);
 * 
 * const authProvider = new EIP4361AuthProvider(provider, signer);
 * const result = await tacoDecrypt(client, payload, { authProvider });
 * console.log(result.plaintext);
 * ```
 */
export async function tacoDecrypt(
  tacoClient: TacoClient,
  payload: EncryptedPayload,
  options: DecryptOptions
): Promise<DecryptionResult> {
  const { authProvider, porterUris } = options;

  if (!tacoClient.isInitialized()) {
    throw new Error('TacoClient not initialized. Call initialize() first.');
  }

  const provider = tacoClient.getProvider();
  const domain = tacoClient.getDomain();

  console.log(`[taco-decrypt] Decrypting message (domain=${domain}, ritual=${payload.ritualId})`);

  try {
    // Dynamic import for TACo SDK
    const tacoModule = await import('@nucypher/taco');
    const { decrypt } = tacoModule;
    
    // Dynamic import for ConditionContext - try multiple paths
    let ConditionContext: any;
    try {
      // @ts-ignore - dynamic path may not resolve in static analysis
      const contextModule = await import('@nucypher/taco/conditions/context');
      ConditionContext = contextModule.ConditionContext;
    } catch {
      // Fallback: ConditionContext might be on main module
      ConditionContext = (tacoModule as any).ConditionContext;
    }

    if (!ConditionContext) {
      throw new Error('ConditionContext not available in TACo SDK.');
    }

    // Deserialize the messageKit
    const messageKit = deserializeMessageKit(payload.messageKit);

    // Create ConditionContext from the payload
    const context = new ConditionContext(
      authProvider,
      payload.condition,
      payload.contextVariables
    );

    // Decrypt the message
    const decryptedBytes = await decrypt(
      provider,
      domain,
      messageKit,
      context,
      porterUris
    );

    // Convert to string
    const plaintext = Buffer.from(decryptedBytes).toString('utf-8');

    console.log(`[taco-decrypt] Message decrypted successfully`);

    return {
      plaintext,
      originalSize: payload.originalSize ?? plaintext.length,
      timestamp: Date.now(),
      success: true,
    };
  } catch (error) {
    console.error('[taco-decrypt] Decryption failed:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Check for common decryption failure reasons
    if (errorMessage.includes('authentication') || errorMessage.includes('signature')) {
      throw new Error(`Decryption failed: Authentication required. User must sign in with their wallet. (${errorMessage})`);
    }
    
    if (errorMessage.includes('condition') || errorMessage.includes('balance')) {
      throw new Error(`Decryption failed: Wallet does not satisfy the access control condition (e.g., insufficient token balance). (${errorMessage})`);
    }

    throw new Error(`Decryption failed: ${errorMessage}`);
  }
}

/**
 * Decrypt a message from IPFS.
 * 
 * @param tacoClient - Initialized TACoClient instance
 * @param cid - IPFS CID of the encrypted payload
 * @param options - Decryption options
 * @param ipfsGetFn - Optional IPFS get function
 * @returns DecryptionResult with the plaintext
 */
export async function tacoDecryptFromIpfs(
  tacoClient: TacoClient,
  cid: string,
  options: DecryptOptions,
  ipfsGetFn?: (cid: string) => Promise<string>
): Promise<DecryptionResult> {
  if (!ipfsGetFn) {
    throw new Error('ipfsGetFn is required to fetch from IPFS');
  }

  console.log(`[taco-decrypt] Fetching payload from IPFS: ${cid}`);
  const json = await ipfsGetFn(cid);
  const payload = jsonToPayload(json);

  return tacoDecrypt(tacoClient, payload, options);
}

// ── Roundtrip Utility ───────────────────────────────────────────────────────

/**
 * Perform a complete encrypt → decrypt roundtrip for testing.
 * 
 * @param encryptClient - Client configured for encryption (with signer)
 * @param decryptClient - Client configured for decryption
 * @param plaintext - Message to encrypt and decrypt
 * @param condition - Access control condition (ConditionProps)
 * @param authProvider - Auth provider for decryption
 * @returns The decrypted plaintext (should match input)
 */
export async function tacoRoundtrip(
  encryptClient: TacoClient,
  decryptClient: TacoClient,
  plaintext: string,
  condition: Record<string, unknown>,
  authProvider: unknown
): Promise<string> {
  const encrypted = await tacoEncrypt(encryptClient, plaintext, condition);
  const result = await tacoDecrypt(decryptClient, encrypted, { authProvider });
  return result.plaintext;
}
