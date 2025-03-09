# AI Vision MCP Server

A Model Context Protocol (MCP) server that provides AI-powered visual analysis capabilities for Claude and other MCP-compatible AI assistants.

## Features

- **Screenshot URL**: Capture screenshots of any website by providing a URL
- **Visual Analysis**: Analyze UI elements, layouts, and content in screenshots
- **File Operations**: Read and modify files with line-specific precision
- **Report Generation**: Create comprehensive UI/UX analysis reports
- **Debugging Session**: Maintain context across multiple analysis steps

## Installation

```bash
# Clone the repository
git clone https://github.com/samihalawa/mcp-server-ai-vision.git
cd mcp-server-ai-vision

# Install dependencies
npm install

# Build the server
npm run build
```

## Usage

### Starting the Server

```bash
npm start
```

### Configuration

Add the server to your MCP configuration:

```json
{
  "servers": {
    "ai-vision": {
      "command": "/path/to/node",
      "args": ["/path/to/mcp-server-ai-vision/build/index.js"],
      "enabled": true,
      "port": 3005,
      "environment": {
        "NODE_PATH": "/path/to/node_modules",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "GEMINI_API_KEY": "your-gemini-api-key"
      }
    }
  }
}
```

### Available Tools

#### screenshot_url

Take a screenshot of a URL using a web browser.

Parameters:
- `url` (string, required): URL to capture a screenshot of (e.g., http://localhost:4999, https://google.com)
- `fullPage` (boolean, optional): Whether to capture full page or just viewport. Default: false
- `waitForSelector` (string, optional): CSS selector to wait for before taking screenshot
- `waitTime` (number, optional): Time to wait in milliseconds before taking screenshot. Default: 1000

#### analyze_screen

Analyze a screenshot with AI vision.

Parameters: None (uses the most recent screenshot)

#### read_file

Read content from a file between specified line numbers.

Parameters:
- `path` (string): Path to the file
- `startLine` (number): Starting line number (1-indexed)
- `endLine` (number): Ending line number (1-indexed)

#### modify_file

Modify content in a file between specified line numbers.

Parameters:
- `path` (string): Path to the file
- `startLine` (number): Starting line number to replace (1-indexed)
- `endLine` (number): Ending line number to replace (1-indexed)
- `content` (string): New content to replace the specified lines

#### generate_report

Generate a comprehensive UI/UX analysis report.

Parameters:
- `testUrl` (string): URL of the application being tested
- `appName` (string, optional): Name of the application being analyzed
- `date` (string, optional): Date of the analysis (YYYY-MM-DD)
- `observations` (object): Observations structured as components, data state, interactions, etc.

## Example Workflow

1. Take a screenshot of a website:
   ```
   screenshot_url(url: "https://example.com")
   ```

2. Analyze the screenshot:
   ```
   analyze_screen()
   ```

3. Generate a report based on the analysis:
   ```
   generate_report(testUrl: "https://example.com", observations: {...})
   ```

## Requirements

- Node.js 14+
- Playwright for browser automation
- Gemini API key for AI vision analysis

## License

MIT 