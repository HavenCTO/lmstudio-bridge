#!/usr/bin/env node
/**
 * Mock LM Studio server for testing the LLM Shim middleware pipeline.
 */

const express = require('express');
const app = express();
const port = process.env.MOCK_LMSTUDIO_PORT || 1234;

app.use(express.json());

// Health check endpoint
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{ id: 'mock-model', object: 'model', created: Date.now(), owned_by: 'test' }]
  });
});

// LM Studio native chat endpoint
app.post('/api/v1/chat', (req, res) => {
  try {
    const { model, input, stream } = req.body;
    
    // Extract content from input (can be string or array)
    let inputContent = '';
    if (typeof input === 'string') {
      inputContent = input;
    } else if (Array.isArray(input) && input.length > 0) {
      // Find the last text input
      for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (item && (item.type === 'message' || item.type === 'text') && item.content) {
          inputContent = item.content;
          break;
        }
      }
    }
    
    console.log(`[mock-lmstudio] Request: model=${model}, content="${inputContent.substring(0, 50)}..."`);

    const response = {
      model_instance_id: 'mock-' + Date.now(),
      output: [{
        type: 'message',
        content: `Mock response. You said: "${inputContent.substring(0, 30)}..."`
      }],
      stats: {
        input_tokens: Math.floor((inputContent.length || 10) / 4),
        total_output_tokens: 15,
        reasoning_output_tokens: 0,
        tokens_per_second: 10.5,
        time_to_first_token_seconds: 0.1
      }
    };

    res.json(response);
  } catch (err) {
    console.error('[mock-lmstudio] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// OpenAI-compatible endpoint
app.post('/v1/chat/completions', (req, res) => {
  try {
    const { model, messages } = req.body;
    const lastMessage = messages?.[messages?.length - 1]?.content || '';
    
    console.log(`[mock-lmstudio] OpenAI request: model=${model}`);

    res.json({
      id: 'chatcmpl-mock-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || 'mock-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: `Mock. You said: "${lastMessage.substring(0, 30)}..."` },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: Math.floor((lastMessage.length || 10) / 4),
        completion_tokens: 10,
        total_tokens: Math.floor((lastMessage.length || 10) / 4) + 10
      }
    });
  } catch (err) {
    console.error('[mock-lmstudio] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[mock-lmstudio] Running on http://0.0.0.0:${port}`);
});
