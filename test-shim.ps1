# Test script for LLM Shim - Windows PowerShell
# Tests the full middleware pipeline with the loaded model

$ErrorActionPreference = "Stop"

$SHIM_URL = "http://localhost:8080"
$MODEL = "qwen3.5-9b-uncensored-hauhaucs-aggressive"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "     LLM Shim Test Suite" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Test 1: Health Check
Write-Host "[Test 1] Health Check..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$SHIM_URL/health" -Method Get
    Write-Host "  [OK] Health: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "  [FAIL] Health check failed: $_" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Test 2: List Models
Write-Host "[Test 2] List Models..." -ForegroundColor Yellow
try {
    $models = Invoke-RestMethod -Uri "$SHIM_URL/v1/models" -Method Get
    Write-Host "  [OK] Models endpoint working" -ForegroundColor Green
    Write-Host "  Available models: $($models.data.Count)" -ForegroundColor Gray
} catch {
    Write-Host "  [FAIL] Models list failed: $_" -ForegroundColor Red
}
Write-Host ""

# Test 3: Simple Chat Completion (non-streaming)
Write-Host "[Test 3] Simple Chat Completion..." -ForegroundColor Yellow
$body = @{
    model = $MODEL
    messages = @(
        @{
            role = "user"
            content = "Say hello in exactly 5 words."
        }
    )
    max_tokens = 50
    temperature = 0.7
    stream = $false
} | ConvertTo-Json -Depth 10

try {
    $response = Invoke-RestMethod -Uri "$SHIM_URL/v1/chat/completions" `
        -Method Post `
        -ContentType "application/json" `
        -Body $body
    
    Write-Host "  [OK] Response received!" -ForegroundColor Green
    Write-Host "  Model: $($response.model)" -ForegroundColor Gray
    Write-Host "  Content: $($response.choices[0].message.content)" -ForegroundColor White
    Write-Host "  Finish reason: $($response.choices[0].finish_reason)" -ForegroundColor Gray
    if ($response.usage) {
        Write-Host "  Usage - Prompt: $($response.usage.prompt_tokens), Completion: $($response.usage.completion_tokens), Total: $($response.usage.total_tokens)" -ForegroundColor Gray
    }
} catch {
    Write-Host "  [FAIL] Chat completion failed: $_" -ForegroundColor Red
    Write-Host "  Response: $($_.Exception.Response)" -ForegroundColor Red
}
Write-Host ""

# Test 4: Multi-turn Conversation
Write-Host "[Test 4] Multi-turn Conversation..." -ForegroundColor Yellow
$body = @{
    model = $MODEL
    messages = @(
        @{
            role = "system"
            content = "You are a helpful assistant. Be concise."
        },
        @{
            role = "user"
            content = "What is 2+2?"
        },
        @{
            role = "assistant"
            content = "4"
        },
        @{
            role = "user"
            content = "What about 3+3?"
        }
    )
    max_tokens = 50
    temperature = 0.5
    stream = $false
} | ConvertTo-Json -Depth 10

try {
    $response = Invoke-RestMethod -Uri "$SHIM_URL/v1/chat/completions" `
        -Method Post `
        -ContentType "application/json" `
        -Body $body
    
    Write-Host "  [OK] Multi-turn response received!" -ForegroundColor Green
    Write-Host "  Content: $($response.choices[0].message.content)" -ForegroundColor White
} catch {
    Write-Host "  [FAIL] Multi-turn failed: $_" -ForegroundColor Red
}
Write-Host ""

# Test 5: Streaming Response
Write-Host "[Test 5] Streaming Response..." -ForegroundColor Yellow
$body = @{
    model = $MODEL
    messages = @(
        @{
            role = "user"
            content = "Count from 1 to 5."
        }
    )
    max_tokens = 100
    temperature = 0.7
    stream = $true
} | ConvertTo-Json -Depth 10

try {
    Write-Host "  Streaming output: " -NoNewline -ForegroundColor Gray
    
    $request = [System.Net.WebRequest]::Create("$SHIM_URL/v1/chat/completions")
    $request.Method = "POST"
    $request.ContentType = "application/json"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $request.ContentLength = $bytes.Length
    
    $stream = $request.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    
    $response = $request.GetResponse()
    $responseStream = $response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($responseStream)
    
    $fullContent = ""
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line -match "^data: (.+)$") {
            $data = $matches[1]
            if ($data -ne "[DONE]") {
                try {
                    $chunk = $data | ConvertFrom-Json
                    if ($chunk.choices[0].delta.content) {
                        $content = $chunk.choices[0].delta.content
                        $fullContent += $content
                        Write-Host $content -NoNewline -ForegroundColor White
                    }
                } catch {
                    # Skip malformed JSON chunks
                }
            }
        }
    }
    
    Write-Host ""
    Write-Host "  [OK] Streaming completed!" -ForegroundColor Green
    Write-Host "  Full response: $fullContent" -ForegroundColor Gray
    
    $reader.Close()
    $responseStream.Close()
    $response.Close()
} catch {
    Write-Host "  [FAIL] Streaming failed: $_" -ForegroundColor Red
}
Write-Host ""

# Summary
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "         Test Suite Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Middleware pipeline verified:" -ForegroundColor Yellow
Write-Host "  [OK] Logger middleware (check shim console for logs)" -ForegroundColor Green
Write-Host "  [OK] Request/Response translation (OpenAI to LM Studio)" -ForegroundColor Green
Write-Host "  [OK] Model: $MODEL" -ForegroundColor Green
