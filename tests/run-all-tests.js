#!/usr/bin/env node
/**
 * Master Test Runner for LLM Shim Middleware Pipeline
 * 
 * Runs all middleware tests in sequence:
 * 1. Gzip middleware test
 * 2. Encrypt middleware test
 * 3. Upload middleware test
 * 4. Full pipeline test
 */

const { spawn } = require('child_process');
const path = require('path');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logSection(title) {
  const width = 60;
  const pad = Math.max(0, (width - title.length - 2) / 2);
  const line = '═'.repeat(width);
  const paddedTitle = ' '.repeat(Math.floor(pad)) + title + ' '.repeat(Math.ceil(pad));
  
  log('\n╔' + line + '╗', 'blue');
  log('║' + paddedTitle + '║', 'blue');
  log('╚' + line + '╝', 'blue');
}

// Run a single test script
function runTest(testName, testFile) {
  return new Promise((resolve) => {
    logSection(`RUNNING: ${testName}`);
    
    const testPath = path.join(__dirname, testFile);
    const proc = spawn('node', [testPath], {
      stdio: 'inherit',
      env: process.env
    });

    proc.on('close', (code) => {
      const success = code === 0;
      log(`\n${testName}: ${success ? 'PASSED ✓' : 'FAILED ✗'}`, success ? 'green' : 'red');
      resolve({ name: testName, success, code });
    });

    proc.on('error', (err) => {
      log(`\n${testName}: ERROR - ${err.message}`, 'red');
      resolve({ name: testName, success: false, error: err.message });
    });
  });
}

// Main runner
async function main() {
  const startTime = Date.now();
  
  logSection('LLM SHIM MIDDLEWARE PIPELINE TEST SUITE');
  
  log('\nEnvironment:', 'cyan');
  log(`  HAVEN_PRIVATE_KEY: ${process.env.HAVEN_PRIVATE_KEY ? '***set***' : 'NOT SET'}`, 'cyan');
  log(`  Working directory: ${process.cwd()}`, 'cyan');
  
  // Check for required env var
  if (!process.env.HAVEN_PRIVATE_KEY) {
    log('\nERROR: HAVEN_PRIVATE_KEY environment variable is required', 'red');
    process.exit(1);
  }

  const tests = [
    { name: 'Gzip Middleware', file: 'test-gzip.js' },
    { name: 'Encrypt Middleware', file: 'test-encrypt.js' },
    { name: 'Upload Middleware', file: 'test-upload.js' },
    { name: 'Full Pipeline', file: 'test-full-pipeline.js' }
  ];

  const results = [];

  for (const test of tests) {
    const result = await runTest(test.name, test.file);
    results.push(result);
    
    // Brief pause between tests
    if (test !== tests[tests.length - 1]) {
      log('\nWaiting 5 seconds before next test...', 'yellow');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Final summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  logSection('FINAL SUMMARY');
  
  let passedCount = 0;
  let failedCount = 0;
  
  for (const result of results) {
    const status = result.success ? '✓ PASS' : '✗ FAIL';
    const color = result.success ? 'green' : 'red';
    log(`  ${status} - ${result.name}`, color);
    
    if (result.success) passedCount++;
    else failedCount++;
  }
  
  log(`\nTotal: ${passedCount} passed, ${failedCount} failed`, failedCount === 0 ? 'green' : 'red');
  log(`Duration: ${duration}s`, 'cyan');
  
  // External endpoint note
  log('\nNote: External endpoint (Hive Compute) was not reachable during testing.', 'yellow');
  log('      Tests were run using a mock LM Studio server for local validation.', 'yellow');

  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
