/**
 * TACo PoC Test Script
 * 
 * Validates basic TACo SDK functionality:
 * - Client initialization
 * - Ritual verification
 * - Condition building
 * - Encrypt/decrypt roundtrip (when credentials available)
 * 
 * Run with: npm run test:taco:poc
 */

import { TacoClient, DEVNET_CONFIG } from '../../src/utils/taco/taco-client';
import { 
  createDaoTokenCondition, 
  validateDaoConditionOptions 
} from '../../src/utils/taco/taco-conditions';

// ── Configuration ───────────────────────────────────────────────────────────

const TEST_CONFIG = {
  // Use environment variables or defaults
  tacoDomain: process.env.TACO_DOMAIN || 'lynx',
  ritualId: parseInt(process.env.TACO_RITUAL_ID || '27', 10),
  rpcUrl: process.env.TACO_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  
  // DAO token condition for testing (Sepolia testnet)
  daoContract: process.env.DAOTOKEN_CONTRACT || '0x11fE4B6AE13d2a6055C8D9cF65c55bac32B5d844', // Sepolia DAI
  daoChain: process.env.DAO_CHAIN || 'sepolia',
  
  // Optional: Private key for encryption tests (DO NOT use in production!)
  testPrivateKey: process.env.TEST_PRIVATE_KEY,
};

// ── Test Helpers ────────────────────────────────────────────────────────────

function logSection(title: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function logSuccess(message: string): void {
  console.log(`✓ ${message}`);
}

function logError(message: string): void {
  console.error(`✗ ${message}`);
}

function logInfo(message: string): void {
  console.log(`  ${message}`);
}

// ── Test Cases ──────────────────────────────────────────────────────────────

async function testClientInitialization(): Promise<boolean> {
  logSection('Test 1: TACo Client Initialization');
  
  try {
    logInfo(`Connecting to domain=${TEST_CONFIG.tacoDomain}, ritualId=${TEST_CONFIG.ritualId}`);
    
    const client = new TacoClient({
      domain: TEST_CONFIG.tacoDomain as any,
      rpcUrl: TEST_CONFIG.rpcUrl,
      ritualId: TEST_CONFIG.ritualId,
    });
    
    await client.initialize();
    
    if (!client.isInitialized()) {
      throw new Error('Client not initialized after initialize() call');
    }
    
    logSuccess('TACo client initialized successfully');
    logInfo(`Provider connected to block`);
    
    return true;
  } catch (error) {
    logError(`Client initialization failed: ${error}`);
    return false;
  }
}

async function testRitualVerification(): Promise<boolean> {
  logSection('Test 2: Ritual Verification');
  
  try {
    const client = new TacoClient({
      domain: TEST_CONFIG.tacoDomain as any,
      rpcUrl: TEST_CONFIG.rpcUrl,
      ritualId: TEST_CONFIG.ritualId,
    });
    
    await client.initialize();
    
    const status = await client.verifyRitual();
    
    if (!status.isActive) {
      logError(`Ritual ${TEST_CONFIG.ritualId} is not active on ${TEST_CONFIG.tacoDomain}`);
      logInfo('This may be expected if using a custom/test ritual ID');
      return false;
    }
    
    logSuccess(`Ritual ${status.ritualId} verified: threshold=${status.threshold.k}/${status.threshold.l}`);
    
    return true;
  } catch (error) {
    logError(`Ritual verification failed: ${error}`);
    return false;
  }
}

async function testConditionBuilding(): Promise<boolean> {
  logSection('Test 3: DAO Condition Building');
  
  try {
    // Test ERC20 condition
    logInfo('Building ERC20 holder condition...');
    const erc20Condition = createDaoTokenCondition({
      type: 'ERC20',
      contractAddress: TEST_CONFIG.daoContract,
      chain: TEST_CONFIG.daoChain,
      minimumBalance: '1000000000000000000', // 1 DAI
    });
    
    logInfo(`ERC20 condition: ${JSON.stringify(erc20Condition, null, 2).substring(0, 100)}...`);
    logSuccess('ERC20 condition built successfully');
    
    // Test ERC721 condition
    logInfo('Building ERC721 holder condition...');
    const erc721Condition = createDaoTokenCondition({
      type: 'ERC721',
      contractAddress: TEST_CONFIG.daoContract,
      chain: TEST_CONFIG.daoChain,
    });
    
    logInfo(`ERC721 condition: ${JSON.stringify(erc721Condition, null, 2).substring(0, 100)}...`);
    logSuccess('ERC721 condition built successfully');
    
    // Test validation
    logInfo('Testing condition validation...');
    await validateDaoConditionOptions({
      type: 'ERC20',
      contractAddress: TEST_CONFIG.daoContract,
      chain: TEST_CONFIG.daoChain,
    });
    logSuccess('Condition validation passed');
    
    // Test invalid address
    try {
      await validateDaoConditionOptions({
        type: 'ERC20',
        contractAddress: 'invalid-address',
        chain: TEST_CONFIG.daoChain,
      });
      logError('Validation should have failed for invalid address');
      return false;
    } catch {
      logSuccess('Validation correctly rejected invalid address');
    }
    
    return true;
  } catch (error) {
    logError(`Condition building failed: ${error}`);
    return false;
  }
}

async function testEncryptionRoundtrip(): Promise<boolean> {
  logSection('Test 4: Encryption Roundtrip (if private key provided)');
  
  if (!TEST_CONFIG.testPrivateKey) {
    logInfo('Skipping: No TEST_PRIVATE_KEY provided');
    logInfo('Set TEST_PRIVATE_KEY env var to enable encryption tests');
    return true; // Not a failure, just skipped
  }
  
  try {
    const { TacoClient, createDaoTokenCondition, tacoEncrypt, tacoDecrypt } = await import('../../src/utils/taco');
    const { EIP4361AuthProvider } = await import('@nucypher/taco-auth');
    
    logInfo('Initializing clients for encryption test...');
    
    // Create encrypting client with signer
    const encryptClient = new TacoClient({
      domain: TEST_CONFIG.tacoDomain as any,
      rpcUrl: TEST_CONFIG.rpcUrl,
      ritualId: TEST_CONFIG.ritualId,
    });
    
    const { ethers } = await import('ethers');
    const wallet = new ethers.Wallet(TEST_CONFIG.testPrivateKey!);
    
    await encryptClient.initialize(wallet);
    
    // Create decrypting client (same wallet for testing)
    const decryptClient = new TacoClient({
      domain: TEST_CONFIG.tacoDomain as any,
      rpcUrl: TEST_CONFIG.rpcUrl,
      ritualId: TEST_CONFIG.ritualId,
    });
    await decryptClient.initialize(wallet);
    
    // Build condition
    const condition = createDaoTokenCondition({
      type: 'ERC20',
      contractAddress: TEST_CONFIG.daoContract,
      chain: TEST_CONFIG.daoChain,
      minimumBalance: '1',
    });
    
    // Encrypt
    logInfo('Encrypting message...');
    const plaintext = 'Hello from TACo PoC!';
    const encrypted = await tacoEncrypt(encryptClient, plaintext, condition);
    logSuccess(`Message encrypted (payload size: ${encrypted.messageKit.length} bytes)`);
    
    // Decrypt
    logInfo('Decrypting message...');
    const provider = decryptClient.getProvider();
    const authProvider = new EIP4361AuthProvider(provider, wallet);
    
    const decrypted = await tacoDecrypt(decryptClient, encrypted, { authProvider });
    
    if (decrypted.plaintext !== plaintext) {
      logError(`Decryption mismatch: expected "${plaintext}", got "${decrypted.plaintext}"`);
      return false;
    }
    
    logSuccess(`Decryption successful: "${decrypted.plaintext}"`);
    
    return true;
  } catch (error) {
    logError(`Encryption roundtrip failed: ${error}`);
    logInfo('This may be expected if the ritual is not properly configured');
    return false;
  }
}

// ── Main Test Runner ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       TACo Migration PoC Test Suite                      ║');
  console.log('║       Target: DEVNET (lynx), Ritual #27                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  const results: Record<string, boolean> = {};
  
  // Run tests
  results['Client Initialization'] = await testClientInitialization();
  results['Ritual Verification'] = await testRitualVerification();
  results['Condition Building'] = await testConditionBuilding();
  results['Encryption Roundtrip'] = await testEncryptionRoundtrip();
  
  // Summary
  logSection('Test Summary');
  
  let passed = 0;
  let failed = 0;
  
  for (const [name, result] of Object.entries(results)) {
    if (result) {
      logSuccess(`${name}: PASSED`);
      passed++;
    } else {
      logError(`${name}: FAILED`);
      failed++;
    }
  }
  
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    console.log('\n⚠️  Some tests failed. Check error messages above.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

// Run if executed directly
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
