# Lit Protocol Removal Plan

## Overview
This document outlines the complete removal of Lit Protocol encryption from the lmstudio-bridge project, migrating fully to TACo (Threshold Access Control) encryption.

## Files to Remove/Modify

### 1. Core Middleware Files
- [ ] **DELETE**: `src/middleware/encrypt.ts` - Lit Protocol encryption middleware
- [ ] **KEEP**: `src/middleware/taco-encrypt.ts` - TACo encryption middleware (already exists)

### 2. Package Dependencies
- [ ] **REMOVE**: `@lit-protocol/lit-node-client` from package.json dependencies

### 3. Main Entry Point (src/index.ts)
- [ ] Remove lit-related CLI options:
  - `--encrypt` (Lit Protocol)
  - `--lit-network`
  - `--lit-chain`
- [ ] Remove lit-related imports:
  - `createEncryptMiddleware`
  - `createLitKeyEncryptor`
  - `EncryptMiddlewareHandle`
- [ ] Remove lit initialization code
- [ ] Remove lit shutdown/cleanup code
- [ ] Update help text to remove Lit references

### 4. Client Retrieval (src/client/retrieval.ts)
- [ ] Remove `recoverKeyViaLit` function
- [ ] Update `RetrievalContext` interface to remove lit-related fields:
  - `litPrivateKey`
  - `litNetwork`
- [ ] Update `retrieveConversation` function to remove lit decryption path

### 5. Type Definitions (src/types/optional-deps.d.ts)
- [ ] Remove lit protocol stubs:
  - `@lit-protocol/lit-client`
  - `@lit-protocol/auth`
  - `@lit-protocol/networks`

### 6. Documentation Files
- [ ] Update `README.md` - Remove Lit references, update encryption section
- [ ] Update `docs/decryption-spec.md` - Remove Lit Protocol sections
- [ ] Update `docs/architecture.md` - Remove Lit references
- [ ] Update `TACO_MIGRATION_SUMMARY.md` - Mark Lit removal as complete

### 7. Test Files
- [ ] **DELETE**: `tests/test-encrypt.js` - Lit Protocol test
- [ ] **DELETE**: `tests/test-encrypt-stub.js` - Lit Protocol stub test
- [ ] **DELETE**: `tests/test-full-pipeline.js` - Contains Lit references
- [ ] Update `tests/test-upload.js` - Remove Lit references if any

### 8. Shell Scripts
- [ ] Update `start-shim.sh` - Remove Lit CLI options

### 9. Archive Files
- [ ] **KEEP**: `src/middleware/archive/encrypt-lit.ts.archive` - Already archived

## Migration Steps

1. Remove lit middleware file
2. Update package.json dependencies
3. Update src/index.ts to remove lit code
4. Update src/client/retrieval.ts
5. Update type definitions
6. Update documentation
7. Remove/update test files
8. Update shell scripts
9. Verify TACo encryption is working
10. Run tests to ensure nothing is broken

## Verification Checklist

- [ ] No lit imports in source code
- [ ] No lit dependencies in package.json
- [ ] No lit CLI options in help text
- [ ] TACo encryption middleware is functional
- [ ] All tests pass
- [ ] Documentation is updated