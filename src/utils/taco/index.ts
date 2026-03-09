/**
 * TACo Utilities Index
 * 
 * Re-exports all TACo-related utilities for convenient importing.
 */

// Client initialization
export {
  TacoClient,
  TacoNetworkConfig,
  DEVNET_CONFIG,
  createTacoClient,
} from './taco-client';

// Condition builders
export {
  createDaoTokenCondition,
  createErc20HolderCondition,
  createErc721HolderCondition,
  validateDaoConditionOptions,
  type DaoTokenOptions,
  type Erc20DaoOptions,
  type Erc721DaoOptions,
  PREDEFINED_DAOS,
} from './taco-conditions';

// Encryption/decryption
export {
  tacoEncrypt,
  tacoDecrypt,
  tacoEncryptToIpfs,
  tacoDecryptFromIpfs,
  tacoRoundtrip,
  serializeMessageKit,
  deserializeMessageKit,
  payloadToJson,
  jsonToPayload,
  type EncryptedPayload,
  type DecryptionResult,
  type EncryptOptions,
  type DecryptOptions,
} from './taco-encryption';

// Authentication
export {
  createEIP4361AuthProvider,
  createAuthProvider,
  isSmartContractWallet,
  getAuthSignature,
  clearAuthCache,
  authSessionManager,
  type AuthProviderWrapper,
  type AuthScheme,
  type EIP4361Options,
} from './taco-auth';
