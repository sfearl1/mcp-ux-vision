#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

// Path to the screenshot to analyze
const screenshotPath = path.join(process.env.HOME, 'Downloads', 'test_screenshot.png');

// Check if the screenshot exists
if (!fs.existsSync(screenshotPath)) {
  console.error(`Screenshot not found at ${screenshotPath}`);
  process.exit(1);
}

// Spawn the MCP server process
const server = spawn('node', ['build/index.js'], {
  stdio: ['pipe', 'pipe', process.stderr]
});

// Set up readline interface for reading from the server's stdout
const rl = readline.createInterface({
  input: server.stdout,
  terminal: false
});

// Set up line-by-line processing of server output
rl.on('line', (line) => {
  try {
    const response = JSON.parse(line);
    console.log('Received response from server:', JSON.stringify(response, null, 2));
    
    // Check if this is a result message and contains any elements
    if (response.result && response.result.content) {
      const analysisText = response.result.content.find(item => item.type === 'text')?.text;
      if (analysisText) {
        console.log('\n----------------- Analysis Result -----------------');
        console.log(analysisText);
        console.log('--------------------------------------------------\n');
      }
      
      // After receiving the result, exit the process
      setTimeout(() => {
        console.log('Test completed successfully!');
        server.kill();
        process.exit(0);
      }, 1000);
    }
  } catch (error) {
    // Not a JSON line or error parsing it, just output it
    console.log('Server output:', line);
  }
});

// Listen for server errors
server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

// Listen for server exit
server.on('exit', (code) => {
  console.log(`Server process exited with code ${code}`);
  process.exit(code);
});

// First, send a listTools request to see what's available
const listTools = () => {
  console.log('Sending tools/list request to the server...');
  const request = {
    jsonrpc: '2.0',
    id: 'list',
    method: 'tools/list',
    params: {}
  };
  server.stdin.write(JSON.stringify(request) + '\n');
};

// Then, send the analyze_screen request
const analyzeScreen = () => {
  console.log('Sending analyze_screen request to the server...');
  const request = {
    jsonrpc: '2.0',
    id: '1',
    method: 'tools/call',
    params: {
      name: 'analyze_screen',
      arguments: {}
    }
  };
  server.stdin.write(JSON.stringify(request) + '\n');
};

// Wait a bit for the server to start up, then list tools first
setTimeout(listTools, 1000);

// Then wait a bit more and send the analyze_screen request
setTimeout(analyzeScreen, 2000);

// Handle process termination
process.on('SIGINT', () => {
  console.log('Terminating test...');
  server.kill();
  process.exit();
}); 