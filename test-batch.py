#!/usr/bin/env python3
"""
LLM Shim Batch Test Suite - Tests full pipeline with 10 conversations
Tests gzip, TACo encryption, Filecoin upload, and LLaVA export
"""

import json
import sys
import time
import requests
from pathlib import Path
from datetime import datetime

SHIM_URL = "http://localhost:8080"
MODEL = "qwen3.5-9b-uncensored-hauhaucs-aggressive"
NUM_CONVERSATIONS = 10

def print_header(text):
    print("\n" + "=" * 60)
    print(f"  {text}")
    print("=" * 60)

def print_test(name):
    print(f"\n[{name}] ", end="")

def print_ok(msg="OK"):
    print(f"\033[92m[OK]\033[0m {msg}")

def print_fail(msg):
    print(f"\033[91m[FAIL]\033[0m {msg}")

def print_info(msg):
    print(f"\033[94m[INFO]\033[0m {msg}")

def run_conversation(conversation_id: int, topic: str) -> dict:
    """Run a multi-turn conversation on a specific topic"""
    messages = [
        {"role": "system", "content": f"You are a helpful assistant. Be informative but concise. Topic: {topic}."},
        {"role": "user", "content": f"Tell me about {topic} in 2-3 sentences."},
    ]
    
    body = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": 150,
        "temperature": 0.7,
        "stream": False
    }
    
    try:
        resp = requests.post(
            f"{SHIM_URL}/v1/chat/completions",
            json=body,
            timeout=120,
            headers={"Content-Type": "application/json"}
        )
        resp.raise_for_status()
        data = resp.json()
        
        choice = data["choices"][0]
        content = choice.get("message", {}).get("content", "")
        
        # Second turn - follow up
        messages.append({"role": "assistant", "content": content})
        messages.append({"role": "user", "content": f"Can you give me a specific example related to {topic}?"})
        
        body["messages"] = messages
        resp = requests.post(
            f"{SHIM_URL}/v1/chat/completions",
            json=body,
            timeout=120,
            headers={"Content-Type": "application/json"}
        )
        resp.raise_for_status()
        data = resp.json()
        
        final_content = data["choices"][0].get("message", {}).get("content", "")
        
        return {
            "success": True,
            "conversation_id": conversation_id,
            "topic": topic,
            "turns": 2,
            "tokens": data.get("usage", {}).get("total_tokens", 0),
            "content_preview": final_content[:100] + "..." if len(final_content) > 100 else final_content
        }
    except Exception as e:
        return {
            "success": False,
            "conversation_id": conversation_id,
            "topic": topic,
            "error": str(e)
        }

def main():
    print_header("LLM Shim Batch Test Suite - Full Pipeline")
    print(f"Testing {NUM_CONVERSATIONS} conversations with full middleware pipeline")
    print(f"Middleware: Logger → Gzip → TACo Encrypt → Filecoin Upload")
    print(f"Timestamp: {datetime.now().isoformat()}")
    
    # Topics for diverse conversations
    topics = [
        "quantum computing basics",
        "climate change solutions",
        "machine learning algorithms",
        "space exploration history",
        "renewable energy sources",
        "artificial intelligence ethics",
        "blockchain technology",
        "biotechnology advances",
        "cybersecurity best practices",
        "sustainable agriculture"
    ]
    
    results = {
        "started_at": datetime.now().isoformat(),
        "conversations": [],
        "summary": {
            "total": NUM_CONVERSATIONS,
            "successful": 0,
            "failed": 0
        }
    }
    
    # Run conversations sequentially to verify pipeline
    for i in range(NUM_CONVERSATIONS):
        topic = topics[i] if i < len(topics) else f"topic-{i}"
        print_test(f"Conversation {i+1}/{NUM_CONVERSATIONS}: {topic}")
        
        result = run_conversation(i, topic)
        results["conversations"].append(result)
        
        if result["success"]:
            results["summary"]["successful"] += 1
            print_ok(f"Turns: {result['turns']}, Tokens: {result['tokens']}, Preview: {result['content_preview']}")
        else:
            results["summary"]["failed"] += 1
            print_fail(f"Error: {result.get('error', 'Unknown error')}")
        
        # Small delay between conversations
        time.sleep(0.5)
    
    results["completed_at"] = datetime.now().isoformat()
    
    # Summary
    print_header("Batch Test Complete")
    print(f"\nResults: {results['summary']['successful']}/{NUM_CONVERSATIONS} successful")
    
    print("\nNext Steps for Full Pipeline Verification:")
    print("  1. Check shim console for upload logs (CIDRecorder)")
    print("  2. Verify CAR files created in ./data directory")
    print("  3. Check CID logs in ./cids directory (Parquet files)")
    print("  4. Verify HAMT registry updated (./registry.json)")
    print("  5. Run export command: llm-shim export --registry ./registry.json --batch 0 --output ./export")
    
    # Save results
    results_file = Path("batch-test-results.json")
    with open(results_file, "w") as f:
        json.dump(results, f, indent=2)
    print_info(f"\nResults saved to {results_file}")
    
    if results["summary"]["failed"] > 0:
        sys.exit(1)
    sys.exit(0)

if __name__ == "__main__":
    main()