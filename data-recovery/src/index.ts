/**
 * LM Studio Bridge Data Recovery Module — V2 Architecture
 *
 * Main entry point for programmatic use of the data recovery tools.
 * Only supports v2 archival format (flat dag-cbor blocks in standard CARv1).
 *
 * @example
 * ```typescript
 * import { recoverBatch, listBatchesFromRegistry } from './data-recovery';
 *
 * // Recover a batch from IPFS
 * const result = await recoverBatch(
 *   { type: 'cid', cid: 'bafy...abc' },
 *   { outputDir: './recovered' }
 * );
 *
 * // Or extract from a local CAR file
 * const result = await recoverBatch(
 *   { type: 'local', filePath: './data/batch-123/merged.car' },
 *   { outputDir: './recovered', splitConversations: true }
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
  // CAR extraction (v2 batch format)
  parseCarFile,
  extractBatch,
  extractConversationByCid,
  exportConversation,
  exportBatch,
  saveBatchToFile,
  saveConversationsToDir,
  decodeBlock,
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
  recoverBatch,
  recoverBatches,
  listBatchesFromRegistry,
} from "./lib/recovery";

// Type exports
export type {
  // Core conversation types (v2)
  RecoveredMessage,
  RecoveredRequest,
  RecoveredResponse,
  RecoveredChoice,
  RecoveredConversation,
  RecoveredBatchRoot,

  // CAR types
  CarBlock,
  CarFileData,
  BatchExtractionResult,

  // Encryption types
  EncryptionMetadata,
  AccessControlCondition,
  DecryptionResult,

  // Retrieval types
  RetrievalResult,
  SynapseRetrievalOptions,

  // Recovery options
  RecoveryOptions,
} from "./types";

export type {
  RecoveryPipelineResult,
  RecoveryPipelineOptions,
} from "./lib/recovery";

export type {
  GatewayRetrievalOptions,
  BatchRetrievalOptions,
} from "./lib/retriever";

export type {
  ExportOptions,
} from "./lib/car-extractor";

export type {
  TacoDecryptionOptions,
  EncryptedKeyData,
  HybridEncryptedData,
  BatchDecryptionResult,
} from "./lib/decryptor";
