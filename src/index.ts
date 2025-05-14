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
import * as wcagContrast from 'wcag-contrast';

// Replace Hugging Face API key with Gemini API key
const GEMINI_API_KEY = 'AIzaSyDRcmawVRBc9rVFEjNc4FeCt_5e8VP72GI';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';
const TEMP_DIR = path.join(os.tmpdir(), 'ai-vision-debug');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
// Define a fixed path for the test screenshot
const TEST_SCREENSHOT_PATH = path.join(os.homedir(), 'Downloads', 'test_screenshot.png');

// Set up logging to a file instead of console - using project-relative paths
const logDir = process.env.MCP_VISION_LOG_DIR || path.join(process.cwd(), 'logs');
try {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
    console.log(`Created log directory: ${logDir}`);
  }
} catch (error: any) {
  console.error(`Failed to create log directory ${logDir}: ${error.message}`);
}

const logFile = path.join(logDir, 'server.log');

function logToFile(message: string): void {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} - ${message}\n`);
  } catch (error) {
    console.error(`Failed to write to log file ${logFile}: ${error}`);
  }
}

// Session state to track current debugging session
interface DebugSession {
  currentUrl: string | null;
  lastScreenshotPath: string | null;
  debugHistory: string[];
  elements: UIElement[];
  lastAnalysisResult: AnalysisResult | null;
}

// Initialize debug session
const debugSession: DebugSession = {
  currentUrl: null,
  lastScreenshotPath: null,
  debugHistory: [],
  elements: [],
  lastAnalysisResult: null,
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

// Define interface for element details (around line 80)
interface Geometry {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface Typography {
  fontFamily?: string;
  fontSize?: number; // Consider using string like '16px' if easier to parse
  fontWeight?: string; // e.g., 'bold', '400', '700'
  color?: string; // Hex or RGB
}

interface Appearance {
  backgroundColor?: string; // Hex or RGB
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
}

// Update UIElement interface
interface UIElement {
  id: number;
  type: string; // Component guess: Button, Input, Text, Link, Image, Card, Section etc.
  label?: string; // Primary visible identifying text (e.g., Button text)
  textContent?: string; // Full text content if applicable
  geometry: Geometry;
  typography?: Typography;
  appearance?: Appearance;
  state?: string; // e.g., 'active', 'disabled', 'focused'
  description?: string; // The detailed description from the AI
}

// Define interface for the analysis result
interface AnalysisResult {
  description: string;
  elements: UIElement[];
  colorPalette?: any;
  typographySystem?: any;
  visualAudit?: any; // Added optional field for the new audit results
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
  // date is removed, we'll use current date
  // observations is removed, we'll get it from the session
  output_path: z.string().optional().describe("Optional base directory path to save the report subdirectory."),
});

// Add schema for URL screenshot
const ScreenshotUrlRequestSchema = z.object({
  url: z.string().describe("URL to capture a screenshot of (e.g., http://localhost:4999, https://google.com)"),
  fullPage: z.boolean().optional().describe("Whether to capture full page or just viewport. Default: false"),
  waitForSelector: z.string().optional().describe("Optional CSS selector to wait for before taking screenshot"),
  waitTime: z.number().optional().describe("Time to wait in milliseconds before taking screenshot. Default: 1000")
});

// --- NEW: Schema for the combined tool ---
const AnalyzeUrlFullReportRequestSchema = z.object({
  url: z.string().describe("URL to capture, analyze, and report on."),
  appName: z.string().optional().describe("Optional name of the application being analyzed."),
  output_path: z.string().optional().describe("Optional base directory path to save the report subdirectory."),
  fullPage: z.boolean().optional().describe("Whether to capture full page or just viewport. Default: false"),
  waitForSelector: z.string().optional().describe("Optional CSS selector to wait for before taking screenshot"),
  waitTime: z.number().optional().describe("Time to wait in milliseconds before taking screenshot. Default: 1000")
});
// --- END NEW Schema ---

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
      const imageData = await fsPromises.readFile(filepath);
      const base64Image = imageData.toString('base64');
      
      // Enhanced prompt requesting detailed attributes
      const prompt = `Analyze this UI screenshot meticulously. Provide the following information in order:

--- General Description Start ---
[Provide a concise overview of the interface, including its visual layout, apparent purpose, and overall impression.]
--- General Description End ---

--- Color Palette Start ---
Backgrounds: ["#hex", "rgb()"]
Text Colors: ["#hex", "rgb()"]
Accent Colors: ["#hex", "rgb()"]
--- Color Palette End ---

--- Typography Summary Start ---
- {fontFamily: "name", fontSize: size(px), fontWeight: "weight"}
--- Typography Summary End ---

For each UI element:
--- Element Start ---
id: [unique integer]
type: [Button/Input/Text/Link/Image/Card/Section/Header/Footer]
label: [visible text label or null if none]
textContent: [full inner text or null]
geometry: {x: int, y: int, width: int, height: int}
typography: {fontFamily: string|null, fontSize: px|null, fontWeight: [normal/bold/numeric|null], color: [hex/rgb|null]}
appearance: {backgroundColor: [hex/rgb|null], borderColor: [hex/rgb|null], borderWidth: px|null, borderRadius: px|null}
state: [active/disabled/hovered/focused/other]
description: [clear explanation of element's role and purpose]
--- Element End ---

--- Visual Audit Start ---
Accessibility:
- Text Legibility: {assessment: [Pass/Fail/Warn/N/A], details: [reasoning vs ~16px baseline]}
- Touch Target Size: {assessment: [Pass/Fail/Warn/N/A], details: [reasoning vs ~44x44px baseline]}
- Label Presence: {assessment: [Pass/Fail/Warn/N/A], details: [reasoning]}

Consistency:
- Typographic Consistency: {assessment: [Consistent/Inconsistent], details: [reasoning]}
- Color Palette Adherence: {assessment: [Consistent/Inconsistent], details: [reasoning]}
- Alignment Consistency: {assessment: [Consistent/Inconsistent], details: [reasoning]}
- Spacing Consistency: {assessment: [Consistent/Inconsistent], details: [reasoning]}

Layout & Density:
- Visual Hierarchy: {assessment: [Clear/Unclear], details: [reasoning]}
- Element Density: {assessment: [Cluttered/Balanced/Sparse], details: [reasoning]}
- White Space Usage: {assessment: [Adequate/Inadequate], details: [reasoning]}
- Text Density: {assessment: [Text-heavy/Balanced], details: [reasoning]}

Clarity:
- CTA Clarity: {assessment: [High/Medium/Low/N/A], details: [reasoning]}
--- Visual Audit End ---

Acknowledge estimations where necessary (e.g., for pixel sizes). Ensure every appearance and typography block includes all keys, even if the value is null.`;
      const payload = {
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/png", data: base64Image } }
            ]
          }
        ],
        generation_config: {
          temperature: 0.1, top_p: 1, top_k: 32, max_output_tokens: 8192,
        }
      };

      const response = await axios.post( `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, payload, { headers: { 'Content-Type': 'application/json' } } );
      const geminiResponse: any = response.data;

      // --- IMPORTANT: Parsing logic below needs significant update ---
      // The simple regex parsing will NOT work for this complex structure.
      // We'll need a more robust parsing approach, maybe:
      // 1. Ask Gemini to format the output as JSON directly (might work).
      // 2. Use more sophisticated text parsing (multiple regexes, state machine) to handle the multi-line, structured element format.
      // 3. For now, we'll placeholder the parsing update, assuming we get the structured data.
      
      if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
        const rawText = geminiResponse.candidates[0].content?.parts[0]?.text || '';
        logToFile(`Raw Gemini response received:\n${rawText}`); // Log for debugging

        // --- Placeholder for new, robust parsing logic ---
        // This part needs careful implementation based on the actual model output format
        const { description, elements, colorPalette, typographySystem, visualAudit } = this.parseDetailedGeminiResponse(rawText);
        // --- End Placeholder ---

        return { description, elements, colorPalette, typographySystem, visualAudit };
      }

      throw new Error('Failed to parse Gemini API response');
    } catch (error: any) {
      logToFile(`Error analyzing with Gemini: ${error}`);
      throw new Error(`Failed to analyze image: ${error?.message || 'Unknown error'}`);
    }
  }

  // Replace the placeholder parseDetailedGeminiResponse function (around line 430)
  private parseDetailedGeminiResponse(rawText: string): { description: string; elements: UIElement[]; colorPalette?: any; typographySystem?: any; visualAudit?: any } {
    logToFile("Parsing detailed Gemini response...");
    const elements: UIElement[] = [];
    let description = "Parsing failed: Could not find general description.";
    let colorPalette: any = null;
    let typographySystem: any = null;

    // --- NEW: Extract generalDescription between explicit markers ---
    const generalDescMatch = rawText.match(/--- General Description Start ---([\s\S]*?)--- General Description End ---/);
    if (generalDescMatch && generalDescMatch[1]) {
      description = generalDescMatch[1].trim();
    } else {
      logToFile("Warning: General Description markers not found in response.");
    }
    logToFile(`Parsed description: ${description.substring(0,100)}...`);

    // Split into element blocks
    const elementBlocks = rawText.split('--- Element Start ---').slice(1); // Skip the description part

    for (const block of elementBlocks) {
      const elementData: any = {};
      const lines = block.split('\n');
      let currentElementId = null;

      try {
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine === '--- Element End ---') continue;

          const separatorIndex = trimmedLine.indexOf(':');
          if (separatorIndex === -1) continue; // Skip lines without ':'

          const key = trimmedLine.substring(0, separatorIndex).trim();
          let value: string | null = trimmedLine.substring(separatorIndex + 1).trim();

          // Handle null values
          if (value.toLowerCase() === 'null') {
            value = null;
          }

          switch (key) {
            case 'id':
              elementData.id = value ? parseInt(value, 10) : null;
              currentElementId = elementData.id; // Track current ID for logging
              break;
            case 'type':
            case 'label':
            case 'textContent':
            case 'state':
            case 'description':
              elementData[key] = value;
              break;
            case 'geometry':
            case 'typography':
            case 'appearance':
              try {
                let obj: any = {};
                if (value && value.startsWith('{') && value.endsWith('}')) {
                  const content = value.substring(1, value.length - 1);
                  const extractValue = (key: string): string | number | null => {
                    const regex = new RegExp(`(?:^|,)\\s*${key}\\s*:\\s*(?:\"([^\"]*)\"|\'([^\']*)\'|([^,\}\{\s]+))`, 'i');
                    const match = content.match(regex);
                    let extracted: string | null = null;
                    if (match) {
                      extracted = match[1] || match[2] || match[3] || null;
                    }
                    if (extracted === null) return null;
                    extracted = extracted.trim();
                    if (extracted.toLowerCase() === 'null') return null;
                    if (extracted.startsWith('~')) extracted = extracted.substring(1);
                    if (['x', 'y', 'width', 'height', 'fontSize', 'borderWidth', 'borderRadius'].includes(key)) {
                      const num = parseFloat(extracted);
                      return isNaN(num) ? extracted.replace(/px$/i, '').trim() : num;
                    }
                    return extracted;
                  };
                  let keysToExtract: string[] = [];
                  if (key === 'geometry') keysToExtract = ['x', 'y', 'width', 'height'];
                  else if (key === 'typography') keysToExtract = ['fontFamily', 'fontSize', 'fontWeight', 'color'];
                  else if (key === 'appearance') keysToExtract = ['backgroundColor', 'borderColor', 'borderWidth', 'borderRadius'];
                  const tempObj: any = {};
                  keysToExtract.forEach(subKey => {
                    const extractedVal = extractValue(subKey);
                    tempObj[subKey] = extractedVal !== undefined ? extractedVal : null; // Always include key
                  });
                  obj = tempObj;
                }
                // --- Set to null if all keys are null or missing ---
                const allNull = obj && Object.values(obj).every(v => v === null || v === undefined);
                elementData[key] = allNull ? null : obj;
              } catch (parseError: any) {
                logToFile(`Error parsing nested object string for key ${key} in element ${currentElementId}: ${value} - Error: ${parseError.message}`);
                elementData[key] = null;
              }
              break;
          }
        }
        if (elementData.id != null) {
          elementData.geometry = elementData.geometry || { x: null, y: null, width: null, height: null };
          elementData.typography = elementData.typography || { fontFamily: null, fontSize: null, fontWeight: null, color: null };
          elementData.appearance = elementData.appearance || { backgroundColor: null, borderColor: null, borderWidth: null, borderRadius: null };
          // If appearance is all null, set to null
          if (elementData.appearance && Object.values(elementData.appearance).every(v => v === null)) {
            elementData.appearance = null;
          }
          elements.push({
            id: elementData.id,
            type: elementData.type || 'Unknown',
            label: elementData.label,
            textContent: elementData.textContent,
            geometry: elementData.geometry,
            typography: elementData.typography,
            appearance: elementData.appearance,
            state: elementData.state || 'active',
            description: elementData.description,
          });
        } else {
          logToFile(`Skipping element block due to missing or invalid ID: ${block.substring(0,100)}...`);
        }
      } catch(elementParseError: any) {
        logToFile(`Failed to parse element block for ID ${currentElementId}: ${elementParseError.message}\nBlock:\n${block}`);
      }
    }
    logToFile(`Parsed elements: ${elements.length} found`);

    // --- NEW: Parse Color Palette ---
    try {
        const colorStartIndex = rawText.indexOf('--- Color Palette Start ---');
        const colorEndIndex = rawText.indexOf('--- Color Palette End ---');
        if (colorStartIndex !== -1 && colorEndIndex !== -1 && colorEndIndex > colorStartIndex) {
            logToFile("Attempting to parse Color Palette section...");
            const colorSectionText = rawText.substring(colorStartIndex + '--- Color Palette Start ---'.length, colorEndIndex).trim();
            const colorData: any = {};
            const lines = colorSectionText.split('\n');
            lines.forEach(line => {
                const [key, valueStr] = line.split(':');
                if (key && valueStr) {
                    try {
                        // --- REVERTED: Back to original simple parsing ---
                        const values = valueStr.trim().replace(/^\\[|\\]$/g, '').split(',')
                                       .map(v => v.trim().replace(/[\'\"]/g, '')) // Basic cleaning
                                       .filter(v => v && v.toLowerCase() !== 'null'); // Filter empty/null
                         colorData[key.trim()] = values;
                    } catch (e: any) {
                        logToFile(`Failed to parse color line: ${line} - Error: ${e.message}`);
                    }
                }
            });
            colorPalette = colorData;
            logToFile(`Parsed Color Palette: ${JSON.stringify(colorPalette)}`);
        } else { logToFile("Color Palette section markers not found in response."); }
    } catch (e: any) { logToFile(`Error during Color Palette parsing: ${e.message}`); }

    // --- NEW: Parse Typography Summary ---
     try {
        const typoStartIndex = rawText.indexOf('--- Typography Summary Start ---');
        const typoEndIndex = rawText.indexOf('--- Typography Summary End ---');
        if (typoStartIndex !== -1 && typoEndIndex !== -1 && typoEndIndex > typoStartIndex) {
            logToFile("Attempting to parse Typography Summary section...");
            const typoSectionText = rawText.substring(typoStartIndex + '--- Typography Summary Start ---'.length, typoEndIndex).trim();
            const typoData: any[] = [];
            const lines = typoSectionText.split('\n');
            lines.forEach(line => {
                 if (line.trim().startsWith('-')) {
                    const objStr = line.trim().substring(1).trim();
                     try {
                        // --- REVERTED: Back to original simple parsing ---
                         const obj: any = {};
                         if (objStr && objStr.startsWith('{') && objStr.endsWith('}')) {
                             const pairs = objStr.substring(1, objStr.length - 1).split(',');
                             pairs.forEach(pair => {
                                 const kv = pair.split(':');
                                 if (kv.length === 2) {
                                     const objKey = kv[0].trim();
                                     let objValue: string | number | null = kv[1].trim().replace(/[\'\"px]/g, ''); // Basic cleaning
                                     if (objKey === 'fontSize') {
                                         const num = parseFloat(objValue as string);
                                         objValue = isNaN(num) ? objValue : num;
                                     }
                                      if (typeof objValue === 'string' && objValue.toLowerCase() === 'null') { objValue = null; }
                                     obj[objKey] = objValue;
                                 }
                             });
                         }
                         if (Object.keys(obj).length > 0) typoData.push(obj);
                     } catch (e: any) {
                        logToFile(`Failed to parse typography line: ${line} - Error: ${e.message}`);
                     }
                 }
            });
            typographySystem = typoData;
            logToFile(`Parsed Typography Summary: Found ${typographySystem.length} items`);
        } else { logToFile("Typography Summary section markers not found in response."); }
    } catch (e: any) { logToFile(`Error during Typography Summary parsing: ${e.message}`); }

    // --- NEW: Parse Visual Audit & Heuristics ---
    let visualAudit: any = null;
    try {
        const auditStartIndex = rawText.indexOf('--- Visual Audit Start ---');
        const auditEndIndex = rawText.indexOf('--- Visual Audit End ---');
        if (auditStartIndex !== -1 && auditEndIndex !== -1 && auditEndIndex > auditStartIndex) {
            logToFile("Attempting to parse Visual Audit section...");
            const auditSectionText = rawText.substring(auditStartIndex + '--- Visual Audit Start ---'.length, auditEndIndex).trim();
            const auditData: any = { accessibility: {}, consistency: {}, layout: {}, clarity: {} }; // Initialize structure
            const lines = auditSectionText.split('\n');
            let currentCategory: string | null = null;

            lines.forEach(line => {
                const trimmedLine = line.trim();
                if (!trimmedLine) return;

                // Detect Category headers
                if (trimmedLine === 'Accessibility:') {
                    currentCategory = 'accessibility';
                } else if (trimmedLine === 'Consistency:') {
                    currentCategory = 'consistency';
                } else if (trimmedLine === 'Layout & Density:') {
                    currentCategory = 'layout';
                } else if (trimmedLine === 'Clarity:') {
                    currentCategory = 'clarity';
                } else if (currentCategory && trimmedLine.startsWith('-')) {
                    // Parse metric line: e.g., "- Text Legibility: { assessment: Pass, details: Good }"
                    const match = trimmedLine.match(/^-\s*([^:]+):\s*\{(.*)\}\s*$/);
                    if (match && match[1] && match[2]) {
                        const metricName = match[1].trim().replace(/ /g, '').replace(/^./, c => c.toLowerCase()); // e.g., textLegibility
                        const metricContent = match[2].trim();
                        const assessmentMatch = metricContent.match(/assessment:\s*([^,]+)/);
                        const detailsMatch = metricContent.match(/details:\s*(.+)$/);
                        
                        const metricData: any = {
                            assessment: assessmentMatch ? assessmentMatch[1].trim() : null,
                            details: detailsMatch ? detailsMatch[1].trim() : null
                        };
                        
                        if (auditData[currentCategory]) {
                             auditData[currentCategory][metricName] = metricData;
                        } else {
                             logToFile(`Warning: Metric found before category: ${metricName}`)
                        }
                    } else {
                        logToFile(`Warning: Could not parse visual audit metric line: ${trimmedLine}`);
                    }
                }
            });
            visualAudit = auditData;
            logToFile(`Parsed Visual Audit: ${JSON.stringify(visualAudit)}`);
        } else { logToFile("Visual Audit section markers not found in response."); }
    } catch (e) { logToFile(`Error during Visual Audit parsing: ${e}`); }

    // --- NEW: Log warning and fallback for missing backgrounds ---
    if (colorPalette && Array.isArray(colorPalette.Backgrounds) && colorPalette.Backgrounds.length === 0) {
      logToFile("Warning: No background colors found in color palette. Assuming black (#000000) as fallback.");
      colorPalette.Backgrounds = ["#000000"];
    }

    // --- UPDATE Return statement ---
    return { description, elements, colorPalette, typographySystem, visualAudit };
  }

  private async generateUIUXReport(appName: string, testUrl: string, outputPath?: string): Promise<any> {
    // Retrieve CACHED data from session
    const analysisResult = debugSession.lastAnalysisResult;
    const screenshotPath = debugSession.lastScreenshotPath;

    // Validate that required data exists in session
    if (!screenshotPath) { throw new Error("No screenshot found in session. Please run screenshot_url first."); }
    if (!analysisResult) { throw new Error("No analysis result found in session. Please run analyze_screen first."); }
    if (!analysisResult.elements || analysisResult.elements.length === 0) { logToFile("Warning: No detailed elements found in cached analysis result for report generation."); }

    // Determine the base reports directory using relative path or environment variable
    const defaultBaseReportsDir = process.env.MCP_VISION_REPORTS_DIR || path.join(process.cwd(), 'reports');
    const baseReportsDir = outputPath || defaultBaseReportsDir;

    // Create a unique subdirectory for this report
    const reportTimestamp = new Date().getTime();
    const reportSubDirName = `report_${reportTimestamp}`;
    const reportDirPath = path.join(baseReportsDir, reportSubDirName);

    try {
      logToFile(`Generating UI/UX report for ${testUrl}. Target Directory: ${reportDirPath}`);
      await fsPromises.mkdir(reportDirPath, { recursive: true });
      logToFile(`Ensured report subdirectory exists: ${reportDirPath}`);

      // 1. Copy the screenshot
      const screenshotFileName = path.basename(screenshotPath);
      const destScreenshotPath = path.join(reportDirPath, screenshotFileName);
      try {
         await fsPromises.copyFile(screenshotPath, destScreenshotPath);
         logToFile(`Copied screenshot to: ${destScreenshotPath}`);
       } catch (copyError: any) {
         logToFile(`Warning: Failed to copy screenshot ${screenshotPath} to ${destScreenshotPath}: ${copyError.message}`);
       }

       // --- NEW: Derive Color Palette and Typography System from elements ---
        const derivedColorPalette: { Backgrounds: string[], TextColors: string[], AccentColors: string[] } = { Backgrounds: [], TextColors: [], AccentColors: [] };
        const derivedTypographySystem: any[] = [];
        const uniqueColors = new Set<string>();
        const uniqueTypography = new Set<string>(); // Store stringified objects to ensure uniqueness

        if (analysisResult.elements) {
            analysisResult.elements.forEach(element => {
                // Collect Colors
                const bgColor = element.appearance?.backgroundColor;
                const textColor = element.typography?.color;
                if (bgColor && typeof bgColor === 'string') uniqueColors.add(bgColor);
                if (textColor && typeof textColor === 'string') uniqueColors.add(textColor);

                // Collect Typography
                if (element.typography) {
                    const { fontFamily, fontSize, fontWeight, color } = element.typography;
                    // Create a consistent representation, handling potential nulls
                    const typoKey = JSON.stringify({
                        fontFamily: fontFamily || 'unknown',
                        fontSize: fontSize != null ? fontSize : 'unknown',
                        fontWeight: fontWeight || 'unknown'
                        // Note: We don't include color here for 'system' definition
                    });
                    if (!uniqueTypography.has(typoKey)) {
                        uniqueTypography.add(typoKey);
                        derivedTypographySystem.push(JSON.parse(typoKey)); // Add the object version
                    }
                }
            });

            // Basic Color Categorization (can be improved)
            uniqueColors.forEach(color => {
                // Simple categorization: Assume dark colors are backgrounds, light are text for now
                // Needs a proper color library for better analysis (luminance check)
                try {
                    if (color.startsWith('#')) {
                        const hex = color.substring(1);
                        const r = parseInt(hex.substring(0, 2), 16);
                        const g = parseInt(hex.substring(2, 4), 16);
                        const b = parseInt(hex.substring(4, 6), 16);
                        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                        if (luminance < 0.5) { // Arbitrary threshold for 'dark'
                            derivedColorPalette.Backgrounds.push(color);
                        } else {
                            derivedColorPalette.TextColors.push(color);
                        }
                    } else {
                        // Add non-hex colors to a category, maybe accents or default to text
                         derivedColorPalette.TextColors.push(color);
                    }
                } catch (e) {
                     // Handle potential parsing errors for non-standard color strings
                     derivedColorPalette.TextColors.push(color);
                     logToFile(`Could not categorize color: ${color}`);
                }

            });
             // Ensure arrays exist even if empty
             derivedColorPalette.Backgrounds = [...new Set(derivedColorPalette.Backgrounds)]; // Unique
             derivedColorPalette.TextColors = [...new Set(derivedColorPalette.TextColors)]; // Unique
             // AccentColors remain empty with this basic logic
        }
        logToFile(`Derived Color Palette: ${JSON.stringify(derivedColorPalette)}`);
        logToFile(`Derived Typography System: ${derivedTypographySystem.length} styles found`);
        // --- End Derivation ---

        // --- Calculate Contrast Ratios (Revised Logic with Extra Logging + Fallback) ---
        if (analysisResult.elements) {
            // Determine a fallback background color (e.g., first from derived backgrounds)
            const defaultBgColor = derivedColorPalette.Backgrounds?.[0] || null;
            if (defaultBgColor) {
                logToFile(`Using default background color fallback for contrast: ${defaultBgColor}`);
            } else {
                 logToFile(`Warning: No default background color found in derived palette for fallback.`);
            }

            analysisResult.elements.forEach(element => {
                const fgColor = element.typography?.color;
                let bgColor = element.appearance?.backgroundColor;
                let usedFallbackBg = false;

                // --- Fallback Logic ---
                if ((!bgColor || typeof bgColor !== 'string') && defaultBgColor) {
                    bgColor = defaultBgColor;
                    usedFallbackBg = true;
                    logToFile(`[Debug Contrast Element ${element.id}] Using fallback background: ${bgColor}`);
                }
                // --- End Fallback Logic ---

                // Log colors before check - Adjust log to show potentially undefined bgColor
                logToFile(`[Debug Contrast Element ${element.id}] fgColor: ${fgColor}, Initial bgColor: ${element.appearance?.backgroundColor}, Final bgColor Used: ${bgColor}`);

                // Check if we have a valid foreground color AND background color
                // bgColor must now be explicitly checked for being a valid string
                if (fgColor && typeof fgColor === 'string' && bgColor && typeof bgColor === 'string') {
                    logToFile(`[Debug Contrast Element ${element.id}] Attempting calculation: ${fgColor} vs ${bgColor}`);
                    try {
                        // Call the hex function from wcag-contrast
                        const ratio = wcagContrast.hex(fgColor, bgColor);
                        logToFile(`[Debug Contrast Element ${element.id}] wcagContrast.hex Result: ${ratio}`); // Updated log message
                        const finalRatio = parseFloat(ratio.toFixed(2));
                         logToFile(`[Debug Contrast Element ${element.id}] Parsed/Rounded Ratio: ${finalRatio}`); // Log the final number
                        (element as any).contrastRatio = finalRatio;
                        logToFile(`[Debug Contrast Element ${element.id}] Assigned ratio: ${finalRatio} ${usedFallbackBg ? '(using fallback BG)' : ''}`); // Log success and if fallback was used

                    } catch (contrastError: any) {
                        logToFile(`[Debug Contrast Element ${element.id}] Error calculating contrast (${fgColor} / ${bgColor}): ${contrastError.message}`);
                        (element as any).contrastRatio = null;
                    }
                } else {
                     // Log reason for setting null
                     let reason = 'Unknown reason';
                     if (!fgColor || typeof fgColor !== 'string') {
                        reason = `Missing or invalid fgColor (${fgColor})`;
                     } else if (!bgColor || typeof bgColor !== 'string') {
                         // This branch should now only be hit if defaultBgColor was also null
                         reason = `Missing or invalid bgColor (${bgColor}) and no fallback available`;
                     }
                     logToFile(`[Debug Contrast Element ${element.id}] Setting contrastRatio to null. Reason: ${reason}`);
                     (element as any).contrastRatio = null;
                }
            });
        }
        // --- End Contrast Calculation ---


      // 2. Create the structured report object using derived data
      const report = {
        title: `UI/UX Analysis Report${appName ? ` for ${appName}` : ''}`,
        date: new Date().toISOString(),
        testUrl,
        analysisSource: {
           screenshotFile: screenshotFileName,
           analysisEngine: "Gemini Vision (via analyze_screen)",
        },
        generalDescription: analysisResult.description,
        // Use DERIVED data, overriding any (likely null) data from direct parsing
        colorPalette: derivedColorPalette,
        typographySystem: derivedTypographySystem,
        visualAudit: analysisResult.visualAudit || null,
        elements: analysisResult.elements
      };

      // 3. Save the JSON report
      const reportFileNameJSON = `report_data_${reportTimestamp}.json`;
      const reportFilePathJSON = path.join(reportDirPath, reportFileNameJSON);
      const reportText = JSON.stringify(report, null, 2);
      
      logToFile(`Attempting to write JSON report to: ${reportFilePathJSON}`);
      await fsPromises.writeFile(reportFilePathJSON, reportText);
      
      return {
        success: true,
        reportDirectory: reportDirPath,
        reportFile: reportFilePathJSON,
        screenshotFile: destScreenshotPath,
      };
    } catch (error: any) {
      logToFile(`Error generating report in target dir (${reportDirPath}): ${error}`);
      throw new Error(`Failed to generate report in target dir (${reportDirPath}): ${error.message}`);
    }
  }

  // --- NEW: Method to handle the combined workflow ---
  private async handleAnalyzeUrlFullReport(args: z.infer<typeof AnalyzeUrlFullReportRequestSchema>): Promise<any> {
    logToFile(`Starting full analysis workflow for URL: ${args.url}`);
    
    // 1. Screenshot
    const screenshotResult = await this.screenshotUrl(
      args.url,
      args.fullPage,
      args.waitForSelector,
      args.waitTime
    );
    logToFile(`Screenshot taken: ${screenshotResult.path}`);

    // 2. Analyze
    const analysisResult = await this.analyzeWithGemini(screenshotResult.path);
    debugSession.lastAnalysisResult = analysisResult; // Store for report generation
    logToFile(`Analysis complete. Found ${analysisResult.elements?.length || 0} elements.`);

    // 3. Generate Report
    const reportResult = await this.generateUIUXReport(
      args.appName || '',
      args.url, // Use the original URL for the report context
      args.output_path
    );
    logToFile(`Report generated: ${reportResult.reportFile}`);

    return reportResult; // Return the report details
  }
  // --- END NEW Method ---

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
          description: 'Generate a comprehensive UI/UX analysis report in a unique subdirectory, including analysis data and the screenshot.',
          inputSchema: {
            type: 'object',
            properties: {
              appName: { type: 'string', description: 'Optional: Name of the application being analyzed' },
              testUrl: { type: 'string', description: 'URL of the application that was tested/screenshot' },
              // No date, no observations
              output_path: { type: 'string', description: 'Optional: Base directory path to save the report subdirectory within.' }
            },
            required: ['testUrl'] // Only testUrl is strictly required now
          }
        },
        // --- NEW Tool Definition ---
        {
          name: 'analyze_url_full_report',
          description: 'Captures a URL screenshot, analyzes it, and generates a full UI/UX report in one step.',
          inputSchema: { 
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to capture, analyze, and report on.' },
              appName: { type: 'string', description: 'Optional name of the application being analyzed.' },
              output_path: { type: 'string', description: 'Optional base directory path to save the report subdirectory.' },
              fullPage: { type: 'boolean', description: 'Whether to capture full page or just viewport. Default: false' },
              waitForSelector: { type: 'string', description: 'Optional CSS selector to wait for before taking screenshot' },
              waitTime: { type: 'number', description: 'Time to wait in milliseconds before taking screenshot. Default: 1000' }
            },
            required: ['url']
          }
        }
        // --- END NEW Tool Definition ---
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
            const screenshot = await this.getTestScreenshot();
            const results = await this.analyzeWithGemini(screenshot.path); // Gets full { description, elements, colorPalette, typographySystem }
            
            // Store detailed results in the debug session cache
            debugSession.lastAnalysisResult = results;
            // Also update the separate elements array for now
            debugSession.elements = results.elements;
            
            // Add to debug history
            debugSession.debugHistory.push(`Screen analyzed: ${results.description.substring(0, 100)}... Found ${results.elements.length} elements.`);

            // Return confirmation message
            const responseText = `Screen analysis complete.\nDescription: ${results.description}\nFound ${results.elements.length} detailed elements. Use 'generate_report' to create the full report and save artifacts.`;
            const debugInfo = debugSession.currentUrl 
              ? `\n\nCurrent debug URL: ${debugSession.currentUrl}\nDebug session has ${debugSession.debugHistory.length} steps`
              : '\n\nNo active debugging session - use screenshot_url to start one';
            return { content: [ { type: 'text', text: responseText + debugInfo } ] };
          } catch (error: any) {
            throw new McpError( ErrorCode.InternalError, `Failed to analyze screen: ${error?.message || 'Unknown error'}` );
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
              output_path?: string;
            };
            if (!args.testUrl) {
              throw new McpError( ErrorCode.InvalidParams, 'Missing required parameter: testUrl' );
            }

            // Check if analysis results are cached in the session
            if (!debugSession.lastAnalysisResult) {
              throw new McpError( ErrorCode.InternalError, 'No analysis results found in session. Run analyze_screen first.' );
            }

            // Call the report function (passing cached results is handled inside generateUIUXReport now)
            const reportResult = await this.generateUIUXReport(
              args.appName || '',
              args.testUrl,
              args.output_path
            );

            // Return details
            return { content: [ { type: 'text', text: JSON.stringify(reportResult, null, 2) } ] };
          } catch (error: any) {
            throw new McpError( ErrorCode.InternalError, `Failed to generate report: ${error?.message || 'Unknown error'}` );
          }
        }

        // --- NEW Case for Combined Tool ---
        case 'analyze_url_full_report': {
          try {
            const args = AnalyzeUrlFullReportRequestSchema.parse(request.params.arguments);
            // Validate URL format
            try {
              new URL(args.url);
            } catch (error) {
              throw new McpError( ErrorCode.InvalidParams, `Invalid URL format: ${args.url}` );
            }

            const reportResult = await this.handleAnalyzeUrlFullReport(args);
            
            // Return details
            return { content: [ { type: 'text', text: JSON.stringify(reportResult, null, 2) } ] };
          } catch (error: any) {
             if (error instanceof z.ZodError) {
              throw new McpError(ErrorCode.InvalidParams, `Invalid parameters: ${error.errors.map(e => e.message).join(', ')}`);
            }
            throw new McpError( ErrorCode.InternalError, `Failed during full analysis workflow: ${error?.message || 'Unknown error'}` );
          }
        }
        // --- END NEW Case ---

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
