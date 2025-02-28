import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

// Replace Hugging Face API key with Gemini API key
const GEMINI_API_KEY = 'AIzaSyDRcmawVRBc9rVFEjNc4FeCt_5e8VP72GI';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';
const TEMP_DIR = path.join(os.tmpdir(), 'ai-vision-debug');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
// Define a fixed path for the test screenshot
const TEST_SCREENSHOT_PATH = path.join(os.homedir(), 'Downloads', 'test_screenshot.png');

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
  label: string;
  coordinates: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// Define interface for the analysis result
interface AnalysisResult {
  description: string;
  elements: UIElement[];
}

class AIVisionDebugServer {
  private server: Server;
  private lastConsoleOutput: string[] = [];

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
            generate_report: true
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
      await fs.access(TEMP_DIR);
    } catch {
      await fs.mkdir(TEMP_DIR, { recursive: true });
    }
  }

  private async cleanup() {
    await this.server.close();
  }

  private async getTestScreenshot(customName?: string): Promise<{ path: string, fileUuid: string }> {
    // Check if the test screenshot exists
    try {
      await fs.access(TEST_SCREENSHOT_PATH);
    } catch (error) {
      throw new Error(`Test screenshot not found at ${TEST_SCREENSHOT_PATH}`);
    }
    
    const fileUuid = randomUUID();
    return { path: TEST_SCREENSHOT_PATH, fileUuid };
  }

  private async readFile(filePath: string, startLine: number, endLine: number): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Adjust for 1-indexed lines coming from the input
      const start = Math.max(0, startLine - 1);
      const end = Math.min(lines.length, endLine);
      
      return lines.slice(start, end).join('\n');
    } catch (error: any) {
      throw new Error(`Failed to read file: ${error?.message || 'Unknown error'}`);
    }
  }

  private async modifyFile(filePath: string, startLine: number, endLine: number, newContent: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Adjust for 1-indexed lines coming from the input
      const start = Math.max(0, startLine - 1);
      const end = Math.min(lines.length, endLine);
      
      // Replace the specified lines with the new content
      const newLines = newContent.split('\n');
      lines.splice(start, end - start, ...newLines);
      
      // Write the modified content back to the file
      await fs.writeFile(filePath, lines.join('\n'));
      
      return `Successfully modified ${filePath} from line ${startLine} to ${endLine}`;
    } catch (error: any) {
      throw new Error(`Failed to modify file: ${error?.message || 'Unknown error'}`);
    }
  }

  private async analyzeWithGemini(filepath: string): Promise<AnalysisResult> {
    try {
      // Read image as base64
      const imageData = await fs.readFile(filepath);
      const base64Image = imageData.toString('base64');
      
      // Prepare the request payload with a simplified prompt that asks for plain text format
      const payload = {
        contents: [
          {
            parts: [
              {
                text: "Analyze this UI screenshot and provide a brief description followed by a list of the main UI elements with their coordinates. Format your response as plain text (not JSON) with the following structure:\n\nDESCRIPTION: [brief description of the screenshot]\n\nUI ELEMENTS:\n1. [Element Type] at x:[x], y:[y], width:[width], height:[height]\n2. [Element Type] at x:[x], y:[y], width:[width], height:[height]\n...\n\nFor each UI element, include only:\n1. A number\n2. The element type (Button, Text, Image, Menu, etc.)\n3. The coordinates as x, y, width, height\n\nDo not include the text content of elements to avoid parsing issues."
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
          temperature: 0.1,  // Very low temperature for consistent output
          top_p: 1,
          top_k: 32,
          max_output_tokens: 2048,
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
          const elementRegex = /(\d+)\.\s+(\w+)\s+at\s+x:(\d+),\s*y:(\d+),\s*width:(\d+),\s*height:(\d+)/g;
          
          const elements: UIElement[] = [];
          let match;
          let id = 1;
          
          while ((match = elementRegex.exec(elementsText)) !== null) {
            elements.push({
              id: id++,
              type: match[2],
              label: `${match[2]} element`, // Generic label since we're not extracting text content
              coordinates: {
                x: parseInt(match[3]),
                y: parseInt(match[4]),
                width: parseInt(match[5]),
                height: parseInt(match[6])
              }
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
      console.error('Error analyzing with Gemini:', error);
      throw new Error(`Failed to analyze image: ${error?.message || 'Unknown error'}`);
    }
  }

  private async generateUIUXReport(appName: string, testUrl: string, date: string, observations: Record<string, any>): Promise<string> {
    const formatDate = date || new Date().toISOString().split('T')[0];
    const appTitle = appName || 'Web Application';
    
    const report = `# UI/UX Analysis Report: ${appTitle}

## Test Environment
- **URL**: ${testUrl}
- **Testing Method**: Visual inspection with screenshot capture at each interaction point
- **Date**: ${formatDate}

## Component Analysis

${Object.entries(observations.components || {}).map(([key, section]: [string, any]) => `
### ${key}
${Object.entries(section || {}).map(([subKey, component]: [string, any]) => `
#### ${subKey}
- **Visual State**: ${component.visualState || 'Not assessed'}
- **Visual Observations**: 
${(component.visualObservations || []).map((obs: string) => `  - ${obs}`).join('\n')}
- **Interaction Results**: 
${(component.interactionResults || []).map((res: string) => `  - ${res}`).join('\n')}
`).join('')}
`).join('')}

## Data State Observations
${(observations.dataState || []).map((obs: string) => `- ${obs}`).join('\n')}

## Interaction Flow Analysis

### Primary User Journeys
${observations.primaryJourneys?.map((journey: any, index: number) => `
${index + 1}. **${journey.name}**
   - Expected: ${journey.expected}
   - Observed: ${journey.observed}
`).join('') || 'No journey data provided'}
   
### Secondary Interactions
${observations.secondaryInteractions?.map((interaction: any, index: number) => `
${index + 1}. **${interaction.name}**
   - Expected: ${interaction.expected}
   - Observed: ${interaction.observed}
`).join('') || 'No interaction data provided'}

## Accessibility Considerations
${(observations.accessibility || []).map((cons: string) => `- ${cons}`).join('\n')}

## Performance Observations
${(observations.performance || []).map((obs: string) => `- ${obs}`).join('\n')}

## Technical Implementation Patterns
${(observations.technicalPatterns || []).map((pattern: string) => `- ${pattern}`).join('\n')}

## Test Coverage Matrix
| Component | Visual Rendering | Interaction Response | State Management |
|-----------|------------------|----------------------|------------------|
${observations.coverageMatrix?.map((row: any) => `| ${row.component} | ${row.visualRendering} | ${row.interactionResponse} | ${row.stateManagement} |`).join('\n') || 'No coverage data provided'}

## Summary of Observations
${observations.summary || 'No summary provided.'}`;

    return report;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'analyze_screen',
          description: 'Analyze a test screenshot with AI vision',
          inputSchema: {
            type: 'object',
            properties: {},
            required: []
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
        case 'analyze_screen': {
          try {
            // Use the fixed screenshot instead of taking a new one
            const screenshot = await this.getTestScreenshot();
            const results = await this.analyzeWithGemini(screenshot.path);
            
            // Format the response to include both description and elements with coordinates
            const formattedDescription = results.description;
            const formattedElements = results.elements.map(element => 
              `${element.id}. ${element.type ? element.type + ': ' : ''}${element.label} [${element.coordinates.x}, ${element.coordinates.y}, ${element.coordinates.width}, ${element.coordinates.height}]`
            ).join('\n');
            
            const responseText = `${formattedDescription}\n\nClickable Elements (with coordinates [x, y, width, height]):\n${formattedElements}`;
            
            return {
              content: [
                {
                  type: 'text',
                  text: responseText
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
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AI Vision Debug MCP server running on stdio');
  }
}

const server = new AIVisionDebugServer();
server.run().catch(console.error);
