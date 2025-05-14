# MCP UX Vision

A Model Context Protocol (MCP) server that provides AI-powered visual analysis capabilities for UI/UX assessment. Compatible with Claude and other MCP-enabled AI assistants.

## Features

- **Screenshot URL**: Capture screenshots of any website by providing a URL
- **Advanced UI Analysis**: Detect UI elements with detailed attributes, typography, colors, and accessibility metrics
- **WCAG Contrast Analysis**: Automatically analyze text contrast ratios for accessibility compliance
- **Visual Heuristics**: Evaluate visual hierarchy, element density, spacing consistency, and more
- **Color Palette Detection**: Extract color palettes from interfaces for design system documentation
- **Typography System Analysis**: Identify and categorize typography styles
- **File Operations**: Read and modify files with line-specific precision
- **Comprehensive Reporting**: Generate detailed UI/UX analysis reports in JSON format
- **Single-Step Analysis**: Capture, analyze, and report in one operation

## Installation

```bash
# Clone the repository
git clone https://github.com/sfearl1/mcp-ux-vision.git
cd mcp-ux-vision

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

### Environment Variables

The server uses these environment variables for configuration:

- `MCP_VISION_LOG_DIR`: Custom location for log files (defaults to `./logs`)
- `MCP_VISION_REPORTS_DIR`: Custom location for report output (defaults to `./reports`)
- `GEMINI_API_KEY`: Your Google Gemini API key for vision analysis

### Configuration

Add the server to your MCP configuration:

```json
{
  "servers": {
    "ux-vision": {
      "command": "/path/to/node",
      "args": ["/path/to/mcp-ux-vision/build/index.js"],
      "enabled": true,
      "port": 3005,
      "environment": {
        "NODE_PATH": "/path/to/node_modules",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "GEMINI_API_KEY": "your-gemini-api-key",
        "MCP_VISION_LOG_DIR": "/path/to/logs",
        "MCP_VISION_REPORTS_DIR": "/path/to/reports"
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

Analyze a screenshot with AI vision, extracting detailed UI information.

Parameters: None (uses the most recent screenshot)

#### generate_report

Generate a comprehensive UI/UX analysis report from the last analysis.

Parameters:
- `testUrl` (string, required): URL of the application being tested
- `appName` (string, optional): Name of the application being analyzed
- `output_path` (string, optional): Base directory path to save the report

#### analyze_url_full_report

One-step workflow that captures a screenshot, analyzes it, and generates a report.

Parameters:
- `url` (string, required): URL to capture, analyze, and report on
- `appName` (string, optional): Name of the application being analyzed
- `output_path` (string, optional): Base directory path to save the report
- `fullPage` (boolean, optional): Whether to capture full page
- `waitForSelector` (string, optional): CSS selector to wait for
- `waitTime` (number, optional): Time to wait in milliseconds

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

## Example Workflow

### Multi-step Analysis

```
# Take a screenshot of a website
screenshot_url(url: "https://example.com")

# Analyze the screenshot
analyze_screen()

# Generate a report based on the analysis
generate_report(testUrl: "https://example.com", appName: "Example Website")
```

### One-step Analysis

```
# Do everything in one step
analyze_url_full_report(url: "https://example.com", appName: "Example Website")
```

## Requirements

- Node.js 14+
- Playwright for browser automation
- Gemini API key for AI vision analysis
- wcag-contrast library for accessibility analysis

## License

MIT