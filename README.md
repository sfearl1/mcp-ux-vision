# MCP UX Vision

An MCP server that provides AI-powered visual analysis for UI/UX assessment using Google's Gemini Vision API.

## Features

- Screenshot capture from URLs
- AI-powered UI element detection and analysis
- WCAG contrast ratio analysis
- Color palette and typography extraction
- Visual accessibility auditing
- Comprehensive JSON reporting

## Installation

```bash
git clone <repository-url>
cd mcp-ux-vision
npm install
npm run build
```

## Configuration

Add to your MCP client configuration:
```json
{
  "servers": {
    "ux-vision": {
      "command": "node",
      "args": [
        "path/to/mcp-ux-vision/build/index.js"
      ]
    }
  }
}
```

## Tools

### screenshot_url
Capture a screenshot of any webpage.
- `url` (required): URL to screenshot
- `fullPage` (optional): Capture full page vs viewport
- `waitTime` (optional): Delay before capture (ms)

### analyze_screen
Analyze the most recent screenshot with AI, extracting:
- UI elements with geometry and styling
- Color palette and typography
- Accessibility metrics
- Visual hierarchy assessment

### generate_report
Create a comprehensive JSON report from the last analysis.
- `testUrl` (required): URL that was analyzed
- `appName` (optional): Application name
- `output_path` (optional): Report output directory

### analyze_url_full_report
One-step workflow combines all above tools with the same parameters: screenshot → analyze → report. 

## Usage

Once the server is running and configured in your MCP client (like Claude), you can use natural language prompts to call the tools:

**screenshot_url**
- "Take a screenshot of https://example.com"
- "Capture a full page screenshot of localhost:3000"
- "Screenshot https://myapp.com and wait for the .loading element to disappear"

**analyze_screen**
- "Analyze the current screenshot for UI elements"
- "Examine the accessibility of this interface"
- "What UI components do you see in the screenshot?"

**generate_report**
- "Create a UX report for the analysis of https://example.com"
- "Generate a comprehensive UI audit report"

**analyze_url_full_report**
- "Take a screenshot of https://example.com and create a full UX analysis report"
- "Analyze https://myapp.com and generate a complete accessibility audit"

## License

MIT