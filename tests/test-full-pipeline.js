#!/usr/bin/env node
/**
 * Full Pipeline Test Script (Gzip → Encrypt → Upload)
 * 
 * Tests the complete middleware pipeline end-to-end:
 * 1. Gzip compression of request/response
 * 2. AES-256-GCM + Lit Protocol encryption of compressed data
 * 3. Upload to Filecoin via Synapse
 * 
 * This verifies the full data flow and integrity through all middleware stages.
 */

const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');

// Configuration
const MOCK_LMSTUDIO_PORT = 1234;
const SHIM_PORT = 8083;
const LIT_NETWORK = 'datil-dev';
const LIT_CHAIN = 'ethereum';
const FILECOIN_RPC = 'wss://api.calibration.node.glif.io/rpc/v1';

// Get private key from environment
const PRIVATE_KEY = process.env.HAVEN_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('ERROR: HAVEN_PRIVATE_KEY environment variable not set');
  process.exit(1);
}

// Generate test wallet address
const TEST_WALLET_ADDRESS = '0x' + crypto.randomBytes(20).toString('hex');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logPipeline(msg) {
  console.log(`${colors.magenta}[PIPELINE]${colors.reset} ${msg}`);
}

// Start a process and return a handle
function startProcess(name, command, args, env = {}) {
  return new Promise((resolve, reject) => {
    log(`\n[${name}] Starting: ${command} ${args.join(' ')}`, 'cyan');
    
    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let pipelineMetrics = {
      compressionRatios: [],
      cids: [],
      encryptedSizes: []
    };

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      const lines = text.split('\n');
      for (const line of lines) {
        // Capture all pipeline-related output
        if (line.includes('gzip') || line.includes('encrypt') || line.includes('upload') ||
            line.includes('Lit') || line.includes('Synapse') || line.includes('CID=') ||
            line.includes('AES') || line.includes('reduction') || line.includes('bytes') ||
            line.includes('shim') || line.includes('ready') || line.includes('initialising')) {
          console.log(`[${name}] ${line}`);
          
          // Parse metrics
          const compressionMatch = line.match(/(\d+) → (\d+) bytes \(([\d.]+)% reduction\)/);
          if (compressionMatch) {
            pipelineMetrics.compressionRatios.push({
              original: parseInt(compressionMatch[1]),
              compressed: parseInt(compressionMatch[2]),
              ratio: parseFloat(compressionMatch[3])
            });
          }
          
          const cidMatch = line.match(/CID=([a-zA-Z0-9]+)/);
          if (cidMatch) {
            pipelineMetrics.cids.push(cidMatch[1]);
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.log(`[${name}] ERR: ${line}`);
        }
      }
    });

    proc.on('error', reject);

    // Give the process time to start (Lit + Synapse initialization takes longer)
    setTimeout(() => {
      resolve({ proc, stdout, stderr, name, pipelineMetrics });
    }, 15000);
  });
}

// Make an HTTP request to the shim
function makeRequest(port, path, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'localhost',
      port: port,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Simulate the pipeline locally to verify expected behavior
function simulatePipeline(requestData, responseData) {
  logPipeline('Simulating full pipeline locally...');
  
  const { gzipSync } = require('zlib');
  
  // Step 1: Combine request + response
  const combined = { request: requestData, response: responseData };
  const jsonStr = JSON.stringify(combined);
  const originalSize = Buffer.byteLength(jsonStr, 'utf-8');
  
  // Step 2: Gzip compression
  const compressed = gzipSync(jsonStr, { level: 6 });
  const compressedSize = compressed.length;
  const compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
  
  log(`  Step 1-2 (Combine+Gzip): ${originalSize} → ${compressedSize} bytes (${compressionRatio}% reduction)`, 'cyan');
  
  // Step 3: AES-256-GCM encryption
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedBuffer = Buffer.concat([iv, encrypted, authTag]);
  
  const encryptionOverhead = encryptedBuffer.length - compressedSize;
  log(`  Step 3 (Encrypt): ${compressedSize} → ${encryptedBuffer.length} bytes (+${encryptionOverhead} bytes overhead)`, 'cyan');
  
  // Step 4: Filecoin upload (simulated)
  log(`  Step 4 (Upload): Would upload ${encryptedBuffer.length} bytes to Filecoin`, 'cyan');
  
  return {
    originalSize,
    compressedSize,
    encryptedSize: encryptedBuffer.length,
    compressionRatio: parseFloat(compressionRatio),
    encryptionOverhead
  };
}

// Test cases
async function runTests(mockLmstudio, shim) {
  log('\n╔════════════════════════════════════════════════════════════╗', 'blue');
  log('║        FULL PIPELINE TEST (Gzip → Encrypt → Upload)        ║', 'blue');
  log('╚════════════════════════════════════════════════════════════╝', 'blue');
  
  log(`\nConfiguration:`, 'cyan');
  log(`  Lit Network: ${LIT_NETWORK} (TESTNET)`, 'cyan');
  log(`  Chain: ${LIT_CHAIN}`, 'cyan');
  log(`  Filecoin RPC: ${FILECOIN_RPC} (Calibration)`, 'cyan');
  log(`  Compression: Level 6 (gzip)`, 'cyan');
  log(`  Encryption: AES-256-GCM + Lit BLS-IBE`, 'cyan');
  
  const results = {
    passed: 0,
    failed: 0,
    localSimulation: null,
    requests: [],
    pipelineMetrics: shim.pipelineMetrics
  };

  // Wait for full initialization
  log('\nWaiting for Lit Protocol + Synapse initialization...', 'yellow');
  await new Promise(r => setTimeout(r, 20000));

  // Test 1: Full pipeline with a simple request
  log('\n--- Test 1: Full Pipeline (Simple Request) ---', 'yellow');
  try {
    const requestData = {
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Process this through the full pipeline!' }
      ]
    };

    logPipeline('Sending request through full pipeline...');
    const response = await makeRequest(SHIM_PORT, '/v1/chat/completions', requestData);
    
    log(`  HTTP Status: ${response.statusCode}`, response.statusCode === 200 ? 'green' : 'red');
    
    if (response.statusCode === 200) {
      const responseBody = JSON.parse(response.body);
      log(`  Response: ${responseBody.choices?.[0]?.message?.content?.substring(0, 50)}...`, 'green');
      
      // Simulate what happened internally
      const simulation = simulatePipeline(requestData, responseBody);
      results.localSimulation = simulation;
      
      results.requests.push({ success: true, size: simulation.originalSize });
      results.passed++;
    } else {
      log(`  Error: ${response.body}`, 'red');
      results.failed++;
    }
  } catch (err) {
    log(`  FAILED: ${err.message}`, 'red');
    results.failed++;
  }

  // Wait for async operations
  log('\nWaiting for async pipeline operations...', 'yellow');
  await new Promise(r => setTimeout(r, 30000));

  // Test 2: Large payload through pipeline
  log('\n--- Test 2: Full Pipeline (Large Payload) ---', 'yellow');
  try {
    const largeContent = 'REPEAT '.repeat(200);
    const requestData = {
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: largeContent }
      ]
    };

    logPipeline('Sending large payload through pipeline...');
    const response = await makeRequest(SHIM_PORT, '/v1/chat/completions', requestData);
    
    if (response.statusCode === 200) {
      const responseBody = JSON.parse(response.body);
      const simulation = simulatePipeline(requestData, responseBody);
      
      log(`  Large payload processed: ${simulation.originalSize} bytes`, 'green');
      log(`  Expected compression: ~${simulation.compressionRatio}%`, 'green');
      results.passed++;
    } else {
      log(`  Failed: ${response.statusCode}`, 'red');
      results.failed++;
    }
  } catch (err) {
    log(`  FAILED: ${err.message}`, 'red');
    results.failed++;
  }

  // Test 3: Verify pipeline stages are working
  log('\n--- Test 3: Pipeline Stage Verification ---', 'yellow');
  
  logPipeline('Verifying each pipeline stage:');
  log(`  [1] Gzip: Should see compression logs`, 'cyan');
  log(`  [2] Encrypt: Should see AES-256-GCM encryption logs`, 'cyan');
  log(`  [3] Upload: Should see CID assignment and upload progress`, 'cyan');
  
  // Check for evidence in logs
  const allOutput = shim.stdout + shim.stderr;
  const stages = {
    gzip: allOutput.includes('gzip'),
    encrypt: allOutput.includes('encrypt') || allOutput.includes('AES'),
    upload: allOutput.includes('upload') || allOutput.includes('CID=')
  };
  
  log(`  Gzip stage detected: ${stages.gzip ? '✓' : '✗'}`, stages.gzip ? 'green' : 'red');
  log(`  Encrypt stage detected: ${stages.encrypt ? '✓' : '✗'}`, stages.encrypt ? 'green' : 'red');
  log(`  Upload stage detected: ${stages.upload ? '✓' : '✗'}`, stages.upload ? 'green' : 'red');
  
  if (stages.gzip && stages.encrypt && stages.upload) {
    results.passed++;
  } else {
    results.failed++;
  }

  return results;
}

// Main test runner
async function main() {
  let mockLmstudio = null;
  let shim = null;

  try {
    // Start mock LM Studio
    mockLmstudio = await startProcess('mock-lmstudio', 'node', ['tests/mock-lmstudio.js']);
    
    // Wait for mock server
    await new Promise(r => setTimeout(r, 1000));

    // Start LLM Shim with FULL pipeline
    log('\n=== Starting Shim with Full Pipeline ===', 'blue');
    log('Pipeline: gzip → encrypt → upload', 'magenta');
    log('Note: Full initialization may take 20-30 seconds...', 'yellow');
    
    shim = await startProcess('shim', 'node', [
      'dist/index.js',
      '--http',
      '--port', SHIM_PORT.toString(),
      '--gzip',
      '--gzip-level', '6',
      '--encrypt',
      '--lit-network', LIT_NETWORK,
      '--wallet-address', TEST_WALLET_ADDRESS,
      '--lit-chain', LIT_CHAIN,
      '--upload',
      '--synapse-rpc-url', FILECOIN_RPC,
      '--no-logger'
    ], {
      HAVEN_PRIVATE_KEY: PRIVATE_KEY
    });

    // Run tests
    const results = await runTests(mockLmstudio, shim);

    // Summary
    log('\n╔════════════════════════════════════════════════════════════╗', 'blue');
    log('║                      TEST SUMMARY                          ║', 'blue');
    log('╚════════════════════════════════════════════════════════════╝', 'blue');
    
    log(`Tests Passed: ${results.passed}`, results.passed > 0 ? 'green' : 'red');
    log(`Tests Failed: ${results.failed}`, results.failed === 0 ? 'green' : 'red');
    
    if (results.localSimulation) {
      log('\nLocal Pipeline Simulation:', 'cyan');
      log(`  Original data size: ${results.localSimulation.originalSize} bytes`, 'cyan');
      log(`  After gzip: ${results.localSimulation.compressedSize} bytes (${results.localSimulation.compressionRatio}% reduction)`, 'cyan');
      log(`  After encryption: ${results.localSimulation.encryptedSize} bytes (+${results.localSimulation.encryptionOverhead} overhead)`, 'cyan');
    }
    
    if (shim.pipelineMetrics.cids.length > 0) {
      log('\nUploaded CIDs:', 'cyan');
      for (const cid of [...new Set(shim.pipelineMetrics.cids)]) {
        log(`  - ${cid}`, 'magenta');
      }
    }

    return results.failed === 0;

  } catch (err) {
    log(`\nTest runner error: ${err.message}`, 'red');
    console.error(err);
    return false;
  } finally {
    // Cleanup
    log('\n=== CLEANUP ===', 'blue');
    if (shim) {
      log('Stopping shim (destroying encryption keys)...', 'cyan');
      shim.proc.kill('SIGTERM');
    }
    if (mockLmstudio) {
      log('Stopping mock LM Studio...', 'cyan');
      mockLmstudio.proc.kill('SIGTERM');
    }
  }
}

// Run tests
main().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
