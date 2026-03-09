#!/bin/bash
# Quick Recovery Script for LM Studio Bridge Testing Data
# 
# Usage: ./quick-recover.sh [OPTIONS]
#
# This script provides a simple interface for recovering testing data
# from IPFS/Synapse with optional TACo decryption.

set -e

# Default values
GATEWAY="https://ipfs.io"
OUTPUT_DIR="./recovered"
METADATA_DIR=""
CID_FILE=""
TACO_DOMAIN="lynx"
TACO_RITUAL_ID="27"
SKIP_DECRYPTION=false
VERBOSE=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_header() {
    echo ""
    echo "=================================================="
    echo "  LM Studio Bridge Data Recovery"
    echo "=================================================="
    echo ""
}

show_help() {
    cat << EOF
Quick Recovery Script for LM Studio Bridge Testing Data

Usage: $0 [OPTIONS]

Options:
  -g, --gateway URL        IPFS gateway URL (default: https://ipfs.io)
  -o, --output DIR         Output directory (default: ./recovered)
  -m, --metadata-dir DIR   Directory with metadata JSON files
  -c, --cid-file FILE      File with list of CIDs (one per line)
  -d, --taco-domain NAME   TACo domain (default: lynx)
  -r, --taco-ritual ID     TACo ritual ID (default: 27)
  -k, --taco-key KEY       TACo private key for decryption
  --skip-decryption        Skip decryption step
  --verbose                Enable verbose logging
  -h, --help               Show this help message

Examples:
  # Recover single CID
  $0 -c cids.txt -o ./recovered

  # Recover with decryption
  $0 -m ./metadata -k \$YOUR_PRIVATE_KEY -o ./decrypted

  # Using environment variables
  export TACO_PRIVATE_KEY="0x..."
  $0 -m ./metadata -o ./decrypted

EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -g|--gateway)
            GATEWAY="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -m|--metadata-dir)
            METADATA_DIR="$2"
            shift 2
            ;;
        -c|--cid-file)
            CID_FILE="$2"
            shift 2
            ;;
        -d|--taco-domain)
            TACO_DOMAIN="$2"
            shift 2
            ;;
        -r|--taco-ritual)
            TACO_RITUAL_ID="$2"
            shift 2
            ;;
        -k|--taco-key)
            TACO_PRIVATE_KEY="$2"
            shift 2
            ;;
        --skip-decryption)
            SKIP_DECRYPTION=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            show_help
            exit 1
            ;;
    esac
done

# Load environment variables from .env.local if exists
if [ -f ".env.local" ]; then
    echo "Loading environment from .env.local..."
    export $(grep -v '^#' .env.local | xargs)
fi

# Build command
CMD="npm run recover-all --"

if [ -n "$METADATA_DIR" ]; then
    CMD="$CMD --metadata-dir $METADATA_DIR"
elif [ -n "$CID_FILE" ]; then
    CMD="$CMD --cid-file $CID_FILE"
else
    print_header
    echo -e "${RED}Error: Must specify either --metadata-dir or --cid-file${NC}"
    echo ""
    show_help
    exit 1
fi

# Add other options
CMD="$CMD --gateway $GATEWAY"
CMD="$CMD --output $OUTPUT_DIR"
CMD="$CMD --taco-domain $TACO_DOMAIN"
CMD="$CMD --taco-ritual-id $TACO_RITUAL_ID"

if [ -n "$TACO_PRIVATE_KEY" ]; then
    CMD="$CMD --taco-private-key $TACO_PRIVATE_KEY"
elif [ -n "$TEST_PRIVATE_KEY" ]; then
    CMD="$CMD --taco-private-key $TEST_PRIVATE_KEY"
fi

if [ "$SKIP_DECRYPTION" = true ]; then
    CMD="$CMD --skip-decryption"
fi

if [ "$VERBOSE" = true ]; then
    CMD="$CMD --verbose"
fi

# Print header and execute
print_header
echo "Running recovery..."
echo "Command: $CMD"
echo ""

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Build if needed
if [ ! -d "dist" ]; then
    echo "Building..."
    npm run build
fi

# Execute
eval $CMD

exit_code=$?

if [ $exit_code -eq 0 ]; then
    echo ""
    echo -e "${GREEN}Recovery completed successfully!${NC}"
    echo "Output directory: $OUTPUT_DIR"
else
    echo ""
    echo -e "${RED}Recovery failed with exit code $exit_code${NC}"
fi

exit $exit_code
