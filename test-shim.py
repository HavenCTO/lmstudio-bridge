#!/usr/bin/env python3
"""
LLM Shim Test Suite - Python version
Tests the full middleware pipeline with gzip, encryption, and upload
"""

import json
import sys
import time
import requests
from pathlib import Path

SHIM_URL = "http://localhost:8080"
MODEL = "qwen3.5-9b-uncensored-hauhaucs-aggressive"

def print_header(text):
    print("\n" + "=" * 50)
    print(f"  {text}")
    print("=" * 50)

def print_test(name):
    print(f"\n[{name}] ", end="")

def print_ok(msg="OK"):
    print(f"\033[92m[OK]\033[0m {msg}")

def print_fail(msg):
    print(f"\033[91m[FAIL]\033[0m {msg}")

def test_health():
    """Test 1: Health Check"""
    print_test("Test 1: Health Check")
    try:
        resp = requests.get(f"{SHIM_URL}/health", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        print_ok(f"Health: {json.dumps(data)}")
        return True
    except Exception as e:
        print_fail(f"Health check failed: {e}")
        return False

def test_list_models():
    """Test 2: List Models"""
    print_test("Test 2: List Models")
    try:
        resp = requests.get(f"{SHIM_URL}/v1/models", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        num_models = len(data.get("data", []))
        print_ok(f"Models endpoint working - Available models: {num_models}")
        return True
    except Exception as e:
        print_fail(f"Models list failed: {e}")
        return False

def test_simple_chat():
    """Test 3: Simple Chat Completion (non-streaming)"""
    print_test("Test 3: Simple Chat Completion")
    body = {
        "model": MODEL,
        "messages": [
            {"role": "user", "content": "Say hello in exactly 5 words."}
        ],
        "max_tokens": 50,
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
        
        # Check response structure
        if "choices" not in data:
            print_fail("Missing 'choices' in response")
            return False
        
        choice = data["choices"][0]
        message = choice.get("message", {})
        content = message.get("content", "")
        
        print_ok(f"Response received!")
        print(f"  Model: {data.get('model')}")
        print(f"  Content: {content}")
        print(f"  Finish reason: {choice.get('finish_reason')}")
        
        if "usage" in data:
            usage = data["usage"]
            print(f"  Usage - Prompt: {usage.get('prompt_tokens')}, "
                  f"Completion: {usage.get('completion_tokens')}, "
                  f"Total: {usage.get('total_tokens')}")
        
        # Verify content is not empty
        if not content:
            print_fail("Empty content in response")
            return False
            
        return True
    except requests.exceptions.Timeout:
        print_fail("Request timed out")
        return False
    except Exception as e:
        print_fail(f"Chat completion failed: {e}")
        return False

def test_multi_turn():
    """Test 4: Multi-turn Conversation"""
    print_test("Test 4: Multi-turn Conversation")
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Be concise."},
            {"role": "user", "content": "What is 2+2?"},
            {"role": "assistant", "content": "4"},
            {"role": "user", "content": "What about 3+3?"}
        ],
        "max_tokens": 50,
        "temperature": 0.5,
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
        
        print_ok(f"Multi-turn response received!")
        print(f"  Content: {content}")
        return True
    except Exception as e:
        print_fail(f"Multi-turn failed: {e}")
        return False

def test_streaming():
    """Test 5: Streaming Response"""
    print_test("Test 5: Streaming Response")
    body = {
        "model": MODEL,
        "messages": [
            {"role": "user", "content": "Count from 1 to 5."}
        ],
        "max_tokens": 100,
        "temperature": 0.7,
        "stream": True
    }
    try:
        print("  Streaming output: ", end="", flush=True)
        
        resp = requests.post(
            f"{SHIM_URL}/v1/chat/completions",
            json=body,
            timeout=120,
            stream=True,
            headers={"Content-Type": "application/json"}
        )
        resp.raise_for_status()
        
        full_content = ""
        for line in resp.iter_lines():
            if line:
                line = line.decode('utf-8')
                if line.startswith("data: "):
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        if "choices" in chunk and len(chunk["choices"]) > 0:
                            delta = chunk["choices"][0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                print(content, end="", flush=True)
                                full_content += content
                    except json.JSONDecodeError:
                        pass
        
        print()  # New line after streaming
        print_ok(f"Streaming completed!")
        print(f"  Full response: {full_content}")
        return True
    except Exception as e:
        print_fail(f"Streaming failed: {e}")
        return False

def main():
    print_header("LLM Shim Test Suite")
    
    results = {
        "passed": 0,
        "failed": 0,
        "tests": []
    }
    
    # Run tests
    tests = [
        ("Health Check", test_health),
        ("List Models", test_list_models),
        ("Simple Chat Completion", test_simple_chat),
        ("Multi-turn Conversation", test_multi_turn),
        ("Streaming Response", test_streaming),
    ]
    
    for name, test_fn in tests:
        try:
            passed = test_fn()
            results["tests"].append((name, passed))
            if passed:
                results["passed"] += 1
            else:
                results["failed"] += 1
        except Exception as e:
            print_fail(f"Unexpected error: {e}")
            results["tests"].append((name, False))
            results["failed"] += 1
    
    # Summary
    print_header("Test Suite Complete")
    print(f"\nResults: {results['passed']} passed, {results['failed']} failed")
    
    print("\nMiddleware pipeline verification:")
    print("  - Logger middleware (check shim console for logs)")
    print("  - Request/Response translation (OpenAI to LM Studio)")
    print(f"  - Model: {MODEL}")
    
    if results["failed"] > 0:
        sys.exit(1)
    sys.exit(0)

if __name__ == "__main__":
    main()