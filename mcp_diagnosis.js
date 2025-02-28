#!/usr/bin/env node

const { spawn } = require('child_process');
const readline = require('readline');

// Spawn the MCP server process
const server = spawn('node', ['build/index.js'], {
  stdio: ['pipe', 'pipe', process.stderr]
});

// Set up readline interface for reading from the server's stdout
const rl = readline.createInterface({
  input: server.stdout,
  terminal: false
});

// Track if we've received the initialization message
let initialized = false;
let requestCount = 0;

// Set up line-by-line processing of server output
rl.on('line', (line) => {
  console.log(`MCP Server output: ${line}`);
  
  try {
    const response = JSON.parse(line);
    console.log('Parsed JSON response:', JSON.stringify(response, null, 2));
    
    // If this is the first message, try to list tools
    if (!initialized) {
      initialized = true;
      console.log('Server initialized. Sending listTools request...');
      
      const listToolsRequest = {
        jsonrpc: '2.0',
        id: 'list-tools',
        method: 'listTools',
        params: {}
      };
      
      server.stdin.write(JSON.stringify(listToolsRequest) + '\n');
    } 
    // After receiving tools list, try to call the analyze_screen tool
    else if (response.id === 'list-tools' && !response.error && requestCount === 0) {
      requestCount++;
      console.log('Received tool list. Sending analyze_screen request...');
      
      const analyzeRequest = {
        jsonrpc: '2.0',
        id: 'analyze-screen',
        method: 'callTool',
        params: {
          name: 'analyze_screen',
          arguments: {}
        }
      };
      
      server.stdin.write(JSON.stringify(analyzeRequest) + '\n');
    }
    
    // If we received the analysis, exit successfully
    if (response.id === 'analyze-screen' && !response.error) {
      console.log('Analysis completed successfully!');
      setTimeout(() => {
        server.kill();
        process.exit(0);
      }, 1000);
    }
    
    // If we received an error, try a different approach
    if (response.error) {
      console.log('Received error response. Trying alternative method...');
      
      // Try without the callTool wrapper
      if (response.error.code === -32601 && requestCount === 1) {
        requestCount++;
        const directRequest = {
          jsonrpc: '2.0',
          id: 'direct-method',
          method: 'analyze_screen',
          params: {}
        };
        
        server.stdin.write(JSON.stringify(directRequest) + '\n');
      }
    }
  } catch (error) {
    console.log('Non-JSON output:', line);
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
  process.exit(code || 0);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('Terminating diagnosis...');
  server.kill();
  process.exit();
});

console.log('Starting MCP server diagnosis...'); 