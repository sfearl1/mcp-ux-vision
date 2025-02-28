# AI Vision Debug MCP Server

This is a Model Context Protocol (MCP) server that provides AI vision capabilities for analyzing UI screenshots.

## Recent Fixes

We made several important fixes to the server:

1. **Fixed Method Names**: Updated the method names to comply with the MCP specification:
   - Changed from custom method names to the standard `tools/list` and `tools/call` methods.

2. **Removed Playwright Dependency**: Modified the server to work without requiring Playwright:
   - Instead of taking screenshots with Playwright, the server now uses a pre-existing screenshot file.
   - This avoids the need to install Playwright's browser, which was causing issues.

3. **Simplified Response Format**: Updated the `analyzeWithGemini` method to:
   - Use a plain text prompt format instead of JSON to avoid parsing issues.
   - Extract UI elements using regex for more reliable parsing.
   - Handle apostrophes and other special characters in the response.

## Available Tools

The server provides the following tools:

- `analyze_screen`: Analyzes a test screenshot with AI vision
- `read_file`: Reads content from a file between specified line numbers
- `modify_file`: Modifies content in a file between specified line numbers
- `generate_report`: Generates a comprehensive UI/UX analysis report

## Usage

1. Make sure you have a test screenshot at `~/Downloads/test_screenshot.png`
2. Build the server: `npm run build`
3. Run the test script: `node test_tool.js`

## Configuration

The server uses the Gemini API for vision analysis. The API key is configured in the `index.ts` file.

## Dependencies

- Node.js
- TypeScript
- axios for API requests
- @modelcontextprotocol/sdk for MCP implementation 