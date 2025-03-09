#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { chromium } from 'playwright';

// Replace Hugging Face API key with Gemini API key
const GEMINI_API_KEY = 'AIzaSyDRcmawVRBc9rVFEjNc4FeCt_5e8VP72GI';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';
const TEMP_DIR = path.join(os.tmpdir(), 'ai-vision-debug');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
// Define a fixed path for the test screenshot
const TEST_SCREENSHOT_PATH = path.join(os.homedir(), 'Downloads', 'test_screenshot.png');

// Set up logging to a file instead of console
const logDir = path.join(os.tmpdir(), 'ai-vision-debug-logs');
try {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
} catch (error) {
  // Silently fail if we can't create the log directory
}

const logFile = path.join(logDir, 'ai-vision-debug.log');

function logToFile(message: string): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} - ${message}\n`);
  } catch (error) {
    // Silently fail if we can't write to the log file
  }
}

// Session state to track current debugging session
interface DebugSession {
  currentUrl: string | null;
  lastScreenshotPath: string | null;
  debugHistory: string[];
  elements: UIElement[];
}

// Initialize debug session
const debugSession: DebugSession = {
  currentUrl: null,
  lastScreenshotPath: null,
  debugHistory: [],
  elements: []
};

// Define interfaces for the Gemini API response
interface GeminiResponsePart {
  text: string;
}

interface GeminiResponseContent {
  parts: GeminiResponsePart[];
  role: string;
}

interface GeminiResponseCandidate {
  content: GeminiResponseContent;
  finishReason: string;
}

interface GeminiResponse {
  candidates: GeminiResponseCandidate[];
}

// Define interface for element with coordinates
interface UIElement {
  id: number;
  type: string;
  label?: string;
  coordinates: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  description?: string;
}

// Define interface for the analysis result
interface AnalysisResult {
  description: string;
  elements: UIElement[];
}

// Add additional schemas for file operations and report generation
const ReadFileRequestSchema = z.object({
  path: z.string().describe("Path to the file to read"),
  startLine: z.number().int().describe("Starting line number (1-indexed)"),
  endLine: z.number().int().describe("Ending line number (1-indexed)"),
});

const ModifyFileRequestSchema = z.object({
  path: z.string().describe("Path to the file to modify"),
  startLine: z.number().int().describe("Starting line number to replace (1-indexed)"),
  endLine: z.number().int().describe("Ending line number to replace (1-indexed)"),
  content: z.string().describe("New content to replace the specified lines"),
});

const GenerateReportRequestSchema = z.object({
  testUrl: z.string().describe("URL of the application being tested"),
  appName: z.string().optional().describe("Name of the application being analyzed"),
  date: z.string().optional().describe("Date of the analysis (YYYY-MM-DD)"),
  observations: z.record(z.any()).describe("Observations structured as components, data state, interactions, etc."),
});

// Add schema for URL screenshot
const ScreenshotUrlRequestSchema = z.object({
  url: z.string().describe("URL to capture a screenshot of (e.g., http://localhost:4999, https://google.com)"),
  fullPage: z.boolean().optional().describe("Whether to capture full page or just viewport. Default: false"),
  waitForSelector: z.string().optional().describe("Optional CSS selector to wait for before taking screenshot"),
  waitTime: z.number().optional().describe("Time to wait in milliseconds before taking screenshot. Default: 1000")
});

class AIVisionDebugServer {
  private server: Server;
  private lastConsoleOutput: string[] = [];
  private browserInstance: any = null;
  private browserContext: any = null;

  constructor() {
    this.server = new Server(
      {
        name: 'ai-vision-debug',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {
            analyze_screen: true,
            // Disable Playwright-dependent tools
            click_point: false,
            take_screenshot: false,
            click_and_screenshot: false,
            click_sequence: false,
            // Keep file-related tools
            read_file: true,
            modify_file: true,
            get_console_output: false,
            generate_report: true,
            screenshot_url: true
          },
        },
      }
    );

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async ensureTempDir() {
    try {
      await fsPromises.access(TEMP_DIR);
    } catch {
      await fsPromises.mkdir(TEMP_DIR, { recursive: true });
    }
  }

  private async cleanup() {
    await this.server.close();
  }

  /**
   * Take a screenshot of a URL using Playwright
   */
  private async screenshotUrl(
    url: string,
    fullPage: boolean = false,
    waitForSelector?: string,
    waitTime: number = 1000
  ): Promise<{ path: string, fileUuid: string }> {
    try {
      logToFile(`Taking screenshot of URL: ${url}`);
      
      // Initialize browser if not already done
      if (!this.browserInstance) {
        logToFile('Initializing browser...');
        this.browserInstance = await chromium.launch({
          headless: true
        });
        this.browserContext = await this.browserInstance.newContext({
          viewport: { width: 1280, height: 800 },
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36'
        });
      }

      // Create a new page
      const page = await this.browserContext.newPage();
      
      // Navigate to the URL
      await page.goto(url, { waitUntil: 'networkidle' });
      
      // Wait for specified time
      await page.waitForTimeout(waitTime);
      
      // Wait for selector if specified
      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout: 10000 });
      }
      
      // Ensure the temp directory exists
      await this.ensureTempDir();
      
      // Generate a UUID for the file
      const fileUuid = randomUUID();
      const screenshotPath = path.join(TEMP_DIR, `screenshot_${fileUuid}.png`);
      
      // Take the screenshot
      await page.screenshot({
        path: screenshotPath,
        fullPage: fullPage
      });
      
      // Close the page but keep browser open for future requests
      await page.close();
      
      // Update the debug session
      debugSession.currentUrl = url;
      debugSession.lastScreenshotPath = screenshotPath;
      debugSession.debugHistory.push(`Screenshot taken of ${url}`);
      
      logToFile(`Screenshot saved to ${screenshotPath}`);
      
      return { path: screenshotPath, fileUuid };
    } catch (error: any) {
      logToFile(`Error taking screenshot: ${error}`);
      throw new Error(`Failed to take screenshot of URL ${url}: ${error.message}`);
    }
  }

  private async getTestScreenshot(customName?: string): Promise<{ path: string, fileUuid: string }> {
    // If we have a screenshot from the URL tool, use that
    if (debugSession.lastScreenshotPath) {
      return { path: debugSession.lastScreenshotPath, fileUuid: randomUUID() };
    }

    // Otherwise use the fixed test screenshot
    try {
      await fsPromises.access(TEST_SCREENSHOT_PATH);
    } catch (error) {
      throw new Error(`Test screenshot not found at ${TEST_SCREENSHOT_PATH}`);
    }
    
    const fileUuid = randomUUID();
    return { path: TEST_SCREENSHOT_PATH, fileUuid };
  }

  private async readFile(filePath: string, startLine: number, endLine: number): Promise<any> {
    try {
      logToFile(`Reading file ${filePath} from line ${startLine} to ${endLine}`);
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      
      const content = await fsPromises.readFile(filePath, 'utf8');
      const lines = content.split('\n');
      
      // Validate line numbers (1-indexed)
      if (startLine < 1 || startLine > lines.length) {
        throw new Error(`Invalid start line: ${startLine}. File has ${lines.length} lines.`);
      }
      
      if (endLine < startLine || endLine > lines.length) {
        throw new Error(`Invalid end line: ${endLine}. File has ${lines.length} lines.`);
      }
      
      // Extract specified lines (adjusting for 0-indexed array)
      const extractedLines = lines.slice(startLine - 1, endLine);
      
      return {
        content: extractedLines.join('\n'),
        lineCount: extractedLines.length
      };
    } catch (error: any) {
      logToFile(`Error reading file: ${error}`);
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  private async modifyFile(filePath: string, startLine: number, endLine: number, content: string): Promise<any> {
    try {
      logToFile(`Modifying file ${filePath} from line ${startLine} to ${endLine}`);
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      
      const fileContent = await fsPromises.readFile(filePath, 'utf8');
      const lines = fileContent.split('\n');
      
      // Validate line numbers (1-indexed)
      if (startLine < 1 || startLine > lines.length + 1) {
        throw new Error(`Invalid start line: ${startLine}. File has ${lines.length} lines.`);
      }
      
      if (endLine < startLine - 1 || endLine > lines.length) {
        throw new Error(`Invalid end line: ${endLine}. File has ${lines.length} lines.`);
      }
      
      // Replace the specified lines with new content
      const newContentLines = content.split('\n');
      const beforeLines = lines.slice(0, startLine - 1);
      const afterLines = lines.slice(endLine);
      
      const modifiedLines = [...beforeLines, ...newContentLines, ...afterLines];
      const modifiedContent = modifiedLines.join('\n');
      
      // Write the modified content back to the file
      await fsPromises.writeFile(filePath, modifiedContent);
      
      return {
        success: true,
        linesModified: (endLine - startLine + 1),
        linesAdded: newContentLines.length
      };
    } catch (error: any) {
      logToFile(`Error modifying file: ${error}`);
      throw new Error(`Failed to modify file: ${error.message}`);
    }
  }

  private async analyzeWithGemini(filepath: string): Promise<AnalysisResult> {
    try {
      // Read image as base64
      const imageData = await fsPromises.readFile(filepath);
      const base64Image = imageData.toString('base64');
      
      // Update prompt to request more detailed element descriptions
      const prompt = "Analyze this UI screenshot and provide a detailed description followed by a comprehensive list of UI elements with their coordinates and detailed descriptions. Format your response as plain text (not JSON) with the following structure:\n\nDESCRIPTION: [thorough description of the screenshot, including application, purpose, and context]\n\nUI ELEMENTS:\n1. [Element Type] at x:[x], y:[y], width:[width], height:[height] - [Detailed description of what this element is, what it does, its state, and importance]\n2. [Element Type] at x:[x], y:[y], width:[width], height:[height] - [Detailed description of what this element is, what it does, its state, and importance]\n...\n\nFor each UI element, be highly descriptive and specific about:\n1. What the element represents (button, link, form field, etc.)\n2. Its current state (active, disabled, selected, etc.)\n3. Its purpose and function in the interface\n4. Any text content that helps identify the element\n5. The coordinates as x, y, width, height\n\nBe as detailed as possible in your descriptions to enable accurate identification.";
      
      const payload = {
        contents: [
          {
            parts: [
              {
                text: prompt
              },
              {
                inline_data: {
                  mime_type: "image/png",
                  data: base64Image
                }
              }
            ]
          }
        ],
        generation_config: {
          temperature: 0.1,
          top_p: 1,
          top_k: 32,
          max_output_tokens: 8192, // Increased to allow for more detailed descriptions
        }
      };

      // Make the API request
      const response = await axios.post(
        `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      // Process the response
      const geminiResponse: any = response.data;
      
      if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
        const content = geminiResponse.candidates[0].content;
        
        if (content && content.parts && content.parts.length > 0) {
          const rawText = content.parts[0].text;
          
          // Parse the plain text response
          const descriptionMatch = rawText.match(/DESCRIPTION:\s*(.*?)(?:\n\n|\n)/s);
          const description = descriptionMatch ? descriptionMatch[1].trim() : 'No description found';
          
          // Extract UI elements using regex
          const elementsText = rawText.split('UI ELEMENTS:')[1] || '';
          const elementRegex = /(\d+)\.\s+(\w+)\s+at\s+x:(\d+),\s*y:(\d+),\s*width:(\d+),\s*height:(\d+)\s*-\s*(.*?)(?=\n\d+\.|\n\n|$)/gs;
          
          const elements: UIElement[] = [];
          let match;
          let id = 1;
          
          while ((match = elementRegex.exec(elementsText)) !== null) {
            elements.push({
              id: parseInt(match[1]),
              type: match[2],
              coordinates: {
                x: parseInt(match[3]),
                y: parseInt(match[4]),
                width: parseInt(match[5]),
                height: parseInt(match[6])
              },
              description: match[7]?.trim() || "No description available" // Add the detailed description
            });
          }
          
          return {
            description,
            elements
          };
        }
      }
      
      throw new Error('Failed to parse Gemini API response');
    } catch (error: any) {
      logToFile(`Error analyzing with Gemini: ${error}`);
      throw new Error(`Failed to analyze image: ${error?.message || 'Unknown error'}`);
    }
  }

  private async generateUIUXReport(appName: string, testUrl: string, date: string, observations: any): Promise<any> {
    try {
      logToFile(`Generating UI/UX report for ${testUrl}`);
      
      // Create a structured report with the provided observations
      const report = {
        title: `UI/UX Analysis Report${appName ? ` for ${appName}` : ''}`,
        date: date || new Date().toISOString().split('T')[0],
        testUrl,
        summary: "UI Analysis performed using Gemini Vision API",
        observations
      };
      
      // Generate a formatted report
      const reportText = JSON.stringify(report, null, 2);
      
      // Write the report to a file (optional)
      const reportFileName = `uiux_report_${new Date().getTime()}.json`;
      await fsPromises.writeFile(reportFileName, reportText);
      
      return {
        success: true,
        report,
        reportFile: reportFileName
      };
    } catch (error: any) {
      logToFile(`Error generating report: ${error}`);
      throw new Error(`Failed to generate report: ${error.message}`);
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'analyze_screen',
          description: 'Analyze a test screenshot with AI vision',
          inputSchema: {
            type: 'object',
            properties: {
              random_string: {
                type: 'string',
                description: 'Dummy parameter for no-parameter tools'
              }
            },
            required: []
          }
        },
        {
          name: 'screenshot_url',
          description: 'Take a screenshot of a URL using a web browser',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL to capture a screenshot of (e.g., http://localhost:4999, https://google.com)'
              },
              fullPage: {
                type: 'boolean',
                description: 'Whether to capture full page or just viewport. Default: false'
              },
              waitForSelector: {
                type: 'string',
                description: 'Optional CSS selector to wait for before taking screenshot'
              },
              waitTime: {
                type: 'number',
                description: 'Time to wait in milliseconds before taking screenshot. Default: 1000'
              }
            },
            required: ['url']
          }
        },
        {
          name: 'read_file',
          description: 'Read content from a file between specified line numbers',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file'
              },
              startLine: {
                type: 'number',
                description: 'Starting line number (1-indexed)'
              },
              endLine: {
                type: 'number',
                description: 'Ending line number (1-indexed)'
              }
            },
            required: ['path', 'startLine', 'endLine']
          }
        },
        {
          name: 'modify_file',
          description: 'Modify content in a file between specified line numbers',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file'
              },
              startLine: {
                type: 'number',
                description: 'Starting line number (1-indexed)'
              },
              endLine: {
                type: 'number',
                description: 'Ending line number (1-indexed)'
              },
              content: {
                type: 'string',
                description: 'New content to replace the specified lines'
              }
            },
            required: ['path', 'startLine', 'endLine', 'content']
          }
        },
        {
          name: 'generate_report',
          description: 'Generate a comprehensive UI/UX analysis report',
          inputSchema: {
            type: 'object',
            properties: {
              appName: {
                type: 'string',
                description: 'Name of the application being analyzed'
              },
              testUrl: {
                type: 'string',
                description: 'URL of the application being tested'
              },
              date: {
                type: 'string',
                description: 'Date of the analysis (YYYY-MM-DD)'
              },
              observations: {
                type: 'object',
                description: 'Observations structured as components, data state, interactions, etc.'
              }
            },
            required: ['testUrl', 'observations']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'screenshot_url': {
          try {
            const args = request.params.arguments as { 
              url: string; 
              fullPage?: boolean;
              waitForSelector?: string;
              waitTime?: number;
            };

            if (!args.url) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'URL is required'
              );
            }
            
            // Validate URL format
            try {
              new URL(args.url);
            } catch (error) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Invalid URL format: ${args.url}`
              );
            }
            
            // Take screenshot
            const screenshot = await this.screenshotUrl(
              args.url, 
              args.fullPage || false,
              args.waitForSelector,
              args.waitTime || 1000
            );
            
            return {
              content: [
                {
                  type: 'text',
                  text: `Screenshot captured successfully from URL: ${args.url}\nPath: ${screenshot.path}\n\nYou can now use 'analyze_screen' to analyze this screenshot.`
                }
              ]
            };
          } catch (error: any) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to capture screenshot: ${error?.message || 'Unknown error'}`
            );
          }
        }
        
        case 'analyze_screen': {
          try {
            // Use the last URL screenshot if available, otherwise fall back to the fixed test screenshot
            const screenshot = await this.getTestScreenshot();
            const results = await this.analyzeWithGemini(screenshot.path);
            
            // Store elements in the debug session
            debugSession.elements = results.elements;
            
            // Add to debug history
            debugSession.debugHistory.push(`Screen analyzed: found ${results.elements.length} elements`);
            
            // Format the response to include both description and elements with coordinates
            const formattedDescription = results.description;
            const formattedElements = results.elements.map(element => 
              `${element.id}. ${element.type ? element.type + ': ' : ''}${element.label} [${element.coordinates.x}, ${element.coordinates.y}, ${element.coordinates.width}, ${element.coordinates.height}]`
            ).join('\n');
            
            const responseText = `${formattedDescription}\n\nClickable Elements (with coordinates [x, y, width, height]):\n${formattedElements}`;
            
            // Include debug session info
            const debugInfo = debugSession.currentUrl 
              ? `\n\nCurrent debug URL: ${debugSession.currentUrl}\nDebug session has ${debugSession.debugHistory.length} steps`
              : '\n\nNo active debugging session - use screenshot_url to start one';
              
            return {
              content: [
                {
                  type: 'text',
                  text: responseText + debugInfo
                }
              ]
            };
          } catch (error: any) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to analyze screen: ${error?.message || 'Unknown error'}`
            );
          }
        }

        case 'read_file': {
          try {
            const args = request.params.arguments as { path: string; startLine: number; endLine: number };
            if (!args.path || typeof args.startLine !== 'number' || typeof args.endLine !== 'number') {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Invalid file read parameters provided'
              );
            }
            
            const content = await this.readFile(args.path, args.startLine, args.endLine);
            
            return {
              content: [
                {
                  type: 'text',
                  text: content
                }
              ]
            };
          } catch (error: any) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to read file: ${error?.message || 'Unknown error'}`
            );
          }
        }

        case 'modify_file': {
          try {
            const args = request.params.arguments as { 
              path: string; 
              startLine: number; 
              endLine: number;
              content: string;
            };
            
            if (!args.path || typeof args.startLine !== 'number' || 
                typeof args.endLine !== 'number' || args.content === undefined) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Invalid file modification parameters provided'
              );
            }
            
            const result = await this.modifyFile(args.path, args.startLine, args.endLine, args.content);
            
            return {
              content: [
                {
                  type: 'text',
                  text: result
                }
              ]
            };
          } catch (error: any) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to modify file: ${error?.message || 'Unknown error'}`
            );
          }
        }
        
        case 'generate_report': {
          try {
            const args = request.params.arguments as { 
              appName?: string; 
              testUrl: string; 
              date?: string;
              observations: Record<string, any>;
            };
            
            if (!args.testUrl || !args.observations) {
              throw new McpError(
                ErrorCode.InvalidParams,
                'Missing required parameters: testUrl and observations'
              );
            }
            
            const report = await this.generateUIUXReport(
              args.appName || '',
              args.testUrl,
              args.date || '',
              args.observations
            );
            
            return {
              content: [
                {
                  type: 'text',
                  text: report
                }
              ]
            };
          } catch (error: any) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to generate report: ${error?.message || 'Unknown error'}`
            );
          }
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });

    // Register additional tools
    /*
    this.server.setRequestHandler(
      "tools/call",
      async (request: any) => {
        if (request.params.name === "mcp__analyze_screen") {
          logToFile("Calling mcp__analyze_screen tool with arguments: " + JSON.stringify(request.params.arguments));
          const result = await this.analyzeWithGemini(request.params.arguments);
          return { result };
        } else if (request.params.name === "mcp__read_file") {
          logToFile("Calling mcp__read_file tool with arguments: " + JSON.stringify(request.params.arguments));
          // Implementation...
        } else if (request.params.name === "mcp__modify_file") {
          logToFile("Calling mcp__modify_file tool with arguments: " + JSON.stringify(request.params.arguments));
          // Implementation...
        } else if (request.params.name === "mcp__generate_report") {
          logToFile("Calling mcp__generate_report tool with arguments: " + JSON.stringify(request.params.arguments));
          // Implementation...
        }
        
        // Default handler
        throw new Error(`Unknown tool: ${request.params.name}`);
      }
    );
    */
  }

  async run() {
    try {
      // Ensure the temp directory exists
      await this.ensureTempDir();
      
      // Set error handler
      this.server.onerror = (error) => {
        logToFile(`MCP Server error: ${error}`);
      };
      
      // Connect the server
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      logToFile('MCP Server started');
      
      // Add cleanup handler
      process.on('SIGINT', async () => {
        logToFile('Shutting down...');
        if (this.browserInstance) {
          await this.browserInstance.close();
        }
        await this.cleanup();
        process.exit(0);
      });
    } catch (error) {
      logToFile(`Failed to start MCP Server: ${error}`);
      process.exit(1);
    }
  }
}

// Start the server
const server = new AIVisionDebugServer();
server.run().catch((error) => {
  logToFile(`Failed to run server: ${error}`);
  process.exit(1);
});
