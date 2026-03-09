/**
 * LM Studio Bridge Data Recovery Module
 *
 * Main entry point for programmatic use of the data recovery tools.
 *
 * @example
 * ```typescript
 * import { recoverConversation, listAvailableCids } from './data-recovery';
 *
 * // Recover a single conversation
 * const result = await recoverConversation(
 *   { type: 'cid', cid: 'bafy...abc' },
 *   { outputDir: './recovered' }
 * );
 * ```
 */

// Re-export all public APIs
export {
  // Retrieval
  retrieveFromGateway,
  retrieveMultipleFromGateway,
  retrieveFromSynapse,
  loadLocalCarFile,
  loadLocalCarFiles,
  batchRetrieve,
} from "./lib/retriever";

export {
  // CAR extraction
  parseCarFile,
  extractConversation,
  extractRequest,
  extractResponse,
  extractMetadata,
  extractMessage,
  extractSystemPrompt,
  exportConversation,
  saveConversationToFile,
  batchExtractConversations,
} from "./lib/car-extractor";

export {
  // Decryption
  decryptHybridData,
  isDataEncrypted,
  parseEncryptionMetadata,
  aesDecrypt,
  parseEncryptedBuffer,
  createTacoDecryptor,
  batchDecrypt,
} from "./lib/decryptor";

export {
  // Recovery orchestration
  recoverConversation,
  recoverConversations,
  recoverEncryptedPayloads,
  listAvailableCids,
} from "./lib/recovery";

// Type exports
export type {
  // Core types
  RecoveredMessage,
  RecoveredRequest,
  RecoveredResponse,
  RecoveredMetadata,
  RecoveredConversation,
  
  // CAR types
  CarBlock,
  CarFileData,
  
  // Encryption types
  EncryptionMetadata,
  AccessControlCondition,
  DecryptionResult,
  
  // Retrieval types
  RetrievalResult,
  SynapseRetrievalOptions,
  
  // Recovery options
  RecoveryOptions,
  RecoveryPipelineOptions,
  BatchDecryptionResult,
} from "./types";
