#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Configuration
const GEMINI_API_KEY = 'AIzaSyDRcmawVRBc9rVFEjNc4FeCt_5e8VP72GI';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';

// Path to the test image
const testImagePath = path.join(process.env.HOME, 'Downloads', 'test_screenshot.png');

// Check if the test image exists
if (!fs.existsSync(testImagePath)) {
  console.error(`Test image not found at ${testImagePath}`);
  process.exit(1);
}

// Function to analyze an image with Gemini Vision API
async function analyzeImage(imagePath) {
  try {
    console.log(`Reading image file: ${imagePath}`);
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    console.log('Preparing request payload with simplified prompt...');
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

    console.log('Sending request to Gemini API...');
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    // Parse the response
    console.log('Processing API response...');
    const geminiResponse = response.data;
    
    if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
      const content = geminiResponse.candidates[0].content;
      
      if (content && content.parts && content.parts.length > 0) {
        const rawText = content.parts[0].text;
        
        console.log('\n----------------- Raw Response -----------------');
        console.log(rawText.substring(0, 500) + (rawText.length > 500 ? '...' : ''));
        console.log('----------------------------------------------\n');
        
        try {
          // Parse the plain text response
          const descriptionMatch = rawText.match(/DESCRIPTION:\s*(.*?)(?:\n\n|\n)/s);
          const description = descriptionMatch ? descriptionMatch[1].trim() : 'No description found';
          
          // Extract UI elements using regex
          const elementsText = rawText.split('UI ELEMENTS:')[1] || '';
          const elementRegex = /(\d+)\.\s+(\w+)\s+at\s+x:(\d+),\s*y:(\d+),\s*width:(\d+),\s*height:(\d+)/g;
          
          const elements = [];
          let match;
          while ((match = elementRegex.exec(elementsText)) !== null) {
            elements.push({
              id: parseInt(match[1]),
              type: match[2],
              coordinates: {
                x: parseInt(match[3]),
                y: parseInt(match[4]),
                width: parseInt(match[5]),
                height: parseInt(match[6])
              }
            });
          }
          
          // Create the analysis result
          const analysisResult = {
            description: description,
            elements: elements
          };
          
          console.log('\n----------------- Analysis Result -----------------');
          console.log(`Description: ${analysisResult.description.substring(0, 150)}...`);
          console.log(`Number of UI elements detected: ${analysisResult.elements.length}`);
          
          // Log a few elements as examples
          if (analysisResult.elements.length > 0) {
            console.log('\nSample UI Elements:');
            const sampleSize = Math.min(5, analysisResult.elements.length);
            for (let i = 0; i < sampleSize; i++) {
              const element = analysisResult.elements[i];
              console.log(`${element.id}. ${element.type} at [${element.coordinates.x}, ${element.coordinates.y}, ${element.coordinates.width}, ${element.coordinates.height}]`);
            }
          }
          
          console.log('--------------------------------------------------\n');
          return analysisResult;
        } catch (error) {
          console.error('Error parsing response:', error);
          console.log('Raw response:', rawText);
          
          // Create a minimal valid result with just the description
          const descriptionMatch = rawText.match(/DESCRIPTION:\s*(.*?)(?:\n\n|\n)/s);
          const description = descriptionMatch ? descriptionMatch[1].trim() : 'Failed to extract description';
          
          return {
            description: description,
            elements: []
          };
        }
      }
    }
    
    console.error('Unexpected response format from Gemini API');
    return null;
  } catch (error) {
    console.error('Error analyzing image:', error.message);
    if (error.response) {
      console.error('API error details:', error.response.data);
    }
    return null;
  }
}

// Main function
async function main() {
  console.log('🔍 Starting direct test of Gemini Vision API for UI analysis');
  
  try {
    const result = await analyzeImage(testImagePath);
    
    if (result) {
      console.log('✅ Test completed successfully!');
      
      // If we have elements, consider it a full success
      if (result.elements && result.elements.length > 0) {
        console.log(`✅ Full analysis successful with ${result.elements.length} UI elements detected`);
      } else {
        console.log('⚠️ Partial success - description extracted but no UI elements');
      }
    } else {
      console.error('❌ Test failed: No valid analysis result received');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Test failed with error:', error);
    process.exit(1);
  }
}

// Run the main function
main(); 