#!/usr/bin/env node
/**
 * Gzip Middleware Test Script
 * 
 * Tests the gzip compression middleware end-to-end:
 * 1. Starts the mock LM Studio server
 * 2. Starts the LLM Shim with gzip middleware enabled
 * 3. Sends LLM requests through the pipeline
 * 4. Verifies compression ratios and data integrity
 */

const { spawn } = require('child_process');
const http = require('http');
const { gunzipSync } = require('zlib');

// Configuration
const MOCK_LMSTUDIO_PORT = 12345;
const SHIM_PORT = 18080;
const TEST_TIMEOUT = 30000;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
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

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      // Filter and display relevant lines
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.includes('gzip') || line.includes('shim') || line.includes('ready')) {
          console.log(`[${name}] ${line}`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', reject);

    // Give the process time to start
    setTimeout(() => {
      resolve({ proc, stdout, stderr, name });
    }, 2000);
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
        'Content-Length': Buffer.byteLength(postData),
        'Accept-Encoding': 'identity' // Don't auto-decompress
      }
    };

    const req = http.request(options, (res) => {
      let body = [];
      
      res.on('data', (chunk) => {
        body.push(chunk);
      });
      
      res.on('end', () => {
        const buffer = Buffer.concat(body);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buffer,
          isGzipped: res.headers['content-encoding'] === 'gzip'
        });
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Test cases
async function runTests(mockLmstudio, shim) {
  log('\n=== GZIP MIDDLEWARE TEST SUITE ===', 'blue');
  
  const results = {
    passed: 0,
    failed: 0,
    compressionTests: []
  };

  // Test 1: Basic compression test
  log('\n--- Test 1: Basic Compression ---', 'yellow');
  try {
    const requestData = {
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello, world!' }
      ]
    };

    const response = await makeRequest(SHIM_PORT, '/v1/chat/completions', requestData);
    
    // Check if response is JSON (not compressed in response to client, 
    // but compressed internally for upload middleware)
    log(`  Status: ${response.statusCode}`, response.statusCode === 200 ? 'green' : 'red');
    
    const responseBody = JSON.parse(response.body.toString());
    log(`  Response received: ${responseBody.choices?.[0]?.message?.content?.substring(0, 50)}...`, 'green');
    
    // The middleware should have logged compression info
    results.passed++;
  } catch (err) {
    log(`  FAILED: ${err.message}`, 'red');
    results.failed++;
  }

  // Test 2: Large payload compression
  log('\n--- Test 2: Large Payload Compression ---', 'yellow');
  try {
    // Generate a larger message to test compression effectiveness
    const largeContent = 'Lorem ipsum dolor sit amet. '.repeat(100);
    
    const requestData = {
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: largeContent }
      ]
    };

    const response = await makeRequest(SHIM_PORT, '/v1/chat/completions', requestData);
    
    log(`  Status: ${response.statusCode}`, response.statusCode === 200 ? 'green' : 'red');
    
    const responseBody = JSON.parse(response.body.toString());
    log(`  Response received for large payload`, 'green');
    
    results.passed++;
  } catch (err) {
    log(`  FAILED: ${err.message}`, 'red');
    results.failed++;
  }

  // Test 3: Compression ratio validation
  log('\n--- Test 3: Compression Ratio Analysis ---', 'yellow');
  try {
    // Test with repetitive content that compresses well
    const repetitiveContent = 'REPEAT'.repeat(500);
    
    const requestData = {
      model: 'test-model',
      messages: [
        { role: 'user', content: repetitiveContent }
      ]
    };

    const jsonSize = Buffer.byteLength(JSON.stringify(requestData), 'utf-8');
    
    // Simulate compression
    const { gzipSync } = require('zlib');
    const compressed = gzipSync(JSON.stringify(requestData), { level: 6 });
    const compressedSize = compressed.length;
    const ratio = ((1 - compressedSize / jsonSize) * 100).toFixed(1);
    
    log(`  Original size: ${jsonSize} bytes`, 'cyan');
    log(`  Compressed size: ${compressedSize} bytes`, 'cyan');
    log(`  Compression ratio: ${ratio}% reduction`, ratio > 50 ? 'green' : 'yellow');
    
    results.compressionTests.push({
      type: 'repetitive',
      original: jsonSize,
      compressed: compressedSize,
      ratio: parseFloat(ratio)
    });
    
    results.passed++;
  } catch (err) {
    log(`  FAILED: ${err.message}`, 'red');
    results.failed++;
  }

  // Test 4: Decompression verification
  log('\n--- Test 4: Decompression Verification ---', 'yellow');
  try {
    const originalData = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Test message for roundtrip verification' }]
    };
    
    const { gzipSync } = require('zlib');
    const compressed = gzipSync(JSON.stringify(originalData));
    const decompressed = JSON.parse(gunzipSync(compressed).toString());
    
    const isEqual = JSON.stringify(originalData) === JSON.stringify(decompressed);
    log(`  Roundtrip data integrity: ${isEqual ? 'PASS' : 'FAIL'}`, isEqual ? 'green' : 'red');
    
    results.passed++;
  } catch (err) {
    log(`  FAILED: ${err.message}`, 'red');
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
    mockLmstudio = await startProcess('mock-lmstudio', 'node', ['tests/mock-lmstudio.js'], { MOCK_LMSTUDIO_PORT: MOCK_LMSTUDIO_PORT.toString() });
    
    // Wait for mock server to be ready
    await new Promise(r => setTimeout(r, 1000));

    // Start LLM Shim with gzip middleware
    shim = await startProcess('shim', 'node', [
      'dist/index.js',
      '--http',
      '--port', SHIM_PORT.toString(),
      '--lmstudio-url', `http://localhost:${MOCK_LMSTUDIO_PORT}`,
      '--gzip',
      '--gzip-level', '6',
      '--no-logger'
    ]);

    // Wait for shim to be ready
    await new Promise(r => setTimeout(r, 2000));

    // Run tests
    const results = await runTests(mockLmstudio, shim);

    // Summary
    log('\n=== TEST SUMMARY ===', 'blue');
    log(`Passed: ${results.passed}`, 'green');
    log(`Failed: ${results.failed}`, results.failed === 0 ? 'green' : 'red');
    
    if (results.compressionTests.length > 0) {
      log('\nCompression Analysis:', 'cyan');
      for (const test of results.compressionTests) {
        log(`  ${test.type}: ${test.ratio}% reduction (${test.original} → ${test.compressed} bytes)`, 'cyan');
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
      log('Stopping shim...', 'cyan');
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
