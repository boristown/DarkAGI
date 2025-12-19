

import { GoogleGenAI, Schema, Type, HarmCategory, HarmBlockThreshold, Part } from "@google/genai";
import { AgentResponse, ModelId, VirtualFile, ChatMessage } from "../types";
import { uint8ArrayToBase64, isGeminiSupportedMimeType, resolveFileContent, base64ToUint8Array } from "../utils/fileUtils";

// Permissive Safety Settings: Set to BLOCK_NONE to allow NSFW/Mature content as requested
const PERMISSIVE_SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

// Schema Definition
const agentSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    thought: {
      type: Type.STRING,
      description: "CRITICAL: MAX 1 short sentence. Why you are taking this specific action."
    },
    final_answer: {
      type: Type.STRING,
      description: "The final answer to the user. MUST be formatted in Markdown (headers, lists, code blocks). Only provide this when task is done."
    },
    plan: {
      type: Type.ARRAY,
      description: "Short, bulleted list of remaining steps.",
      items: { type: Type.STRING }
    },
    risk_assessment: {
      type: Type.OBJECT,
      properties: {
        has_destructive_actions: { type: Type.BOOLEAN },
        confirmation_required_ids: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "List of high-risk operation IDs."
        }
      },
      required: ["has_destructive_actions", "confirmation_required_ids"]
    },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: "Unique operation ID" },
          type: {
            type: Type.STRING,
            // Added "google_search"
            enum: ["read", "write", "append", "move", "delete", "mkdir", "generate_image", "edit_image", "compose_image", "calculate_math", "generate_video", "trim_video", "run_script", "google_search"],
            description: "Action type"
          },
          path: { type: Type.STRING, description: "Target file path. For image/video actions, this is the OUTPUT path. For 'google_search', this is the QUERY TOPIC (e.g., 'search_results.txt' or just a placeholder)." },
          content: {
            type: Type.STRING,
            description: "Parameter Payload. For 'google_search', this is the SEARCH QUERY. For 'trim_video', provide JSON string '{\"start\": 0, \"end\": 10}'. For others, use normal text/prompt."
          },
          source_path: {
            type: Type.STRING,
            description: "MANDATORY for 'edit_image', 'move', 'trim_video'. ONLY include if the action requires a source."
          },
          source_paths: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "MANDATORY for 'compose_image'. OMIT for all other actions."
          },
          description: { type: Type.STRING, description: "Short description" }
        },
        required: ["id", "type", "path"]
      }
    }
  },
  required: ["thought", "plan", "actions", "risk_assessment"]
};

const SYSTEM_INSTRUCTION = `
You are "DarkAGI", an Advanced Autonomous Agent with Native Multimodal and Web Capabilities.

## OBJECTIVE
Execute the user's instructions efficiently using the provided tools. 

## AVAILABLE TOOLS
1. **File Ops**: 
   - \`read\`: **PRIMARY ANALYSIS TOOL**. Use this to read text OR **watch/view** binary files (Videos, Images, PDFs). The system will attach the file content to your context so you can see it.
   - \`write\`, \`append\`, \`move\`, \`delete\`, \`mkdir\`.
2. **Web Ops**:
   - \`google_search\`: Search the internet for real-time information, news, or facts. Put the search query in \`content\`.
3. **Image Ops**:
   - \`generate_image\`: Create new images.
   - \`edit_image\`: Modify existing images.
   - \`compose_image\`: Merge images.
4. **Video Ops**: \`generate_video\` (Create), \`trim_video\` (Edit).
5. **Math**: \`calculate_math\` (Only use when explicitly asked to calculate numbers).
6. **Code**: \`run_script\` (Use for logic/data processing. DO NOT use this to "analyze" media files; use \`read\` instead).

## CRITICAL RULES
1. **MULTIMODAL PERCEPTION**: You can NATIVELY understand Videos and Images. To know what is in "video.mp4", simply use \`read\` on it. DO NOT say you cannot analyze it. DO NOT try to write a script to parse it.
2. **NO HALLUCINATION**: Only use tools required by the user's prompt.
3. **STRICT TOOL USAGE**:
   - Do NOT use \`calculate_math\` unless the user asks for a math calculation.
   - Do NOT use \`edit_image\` without a valid \`source_path\`.
   - Use \`google_search\` when asked about current events or info not in your training data.
4. **CONCISENESS**: 
   - \`thought\` must be 1 short sentence.
   - Total JSON length < 4080 chars.
5. **JSON**: Output raw JSON matching the schema.

## FINAL ANSWER FORMATTING
- The \`final_answer\` field is for the HUMAN user. 
- **USE MARKDOWN**: Use headers (#), bullet points (-), and bold text (**).
- **CODE BLOCKS**: If outputting code, YOU MUST wrap it in Markdown code blocks (e.g., \`\`\`typescript ... \`\`\`). 
- **NO RAW JSON**: Do NOT dump the internal JSON structure or your plan into the \`final_answer\`.

## RESPONSE FORMAT
- Return a JSON object with:
  - \`thought\`: Brief reasoning.
  - \`plan\`: Remaining steps.
  - \`actions\`: Array of tool calls.
  - \`risk_assessment\`: Check for destructive actions.
  - \`final_answer\`: Final text response formatted in Markdown (only when done).
`;

const extractJSONString = (text: string, propName: string): string | null => {
    // 1. Try robust complete extraction
    const regex = new RegExp(`"${propName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s");
    const match = text.match(regex);
    if (match) {
        return match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    // 2. Try streaming/partial extraction (unclosed quote)
    const regexPartial = new RegExp(`"${propName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "s");
    const matchPartial = text.match(regexPartial);
    if (matchPartial) {
        return matchPartial[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    return null;
};

const extractJSONArray = (text: string, propName: string): string[] => {
    // Basic extraction for streaming JSON Arrays (specifically string arrays like 'plan')
    // Matches "plan": [ "Item 1", "Item 2" ...
    const regex = new RegExp(`"${propName}"\\s*:\\s*\\[(.*?)(?:\\]|$)`, "s");
    const match = text.match(regex);
    if (match) {
        const content = match[1];
        // naive split by quotes, decent enough for display
        const items = content.match(/"((?:[^"\\\\]|\\\\.)*)"/g);
        if (items) {
             return items.map(i => i.slice(1, -1)
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
             );
        }
    }
    return [];
};

// Simple check to see if two action sets are essentially the same
const areActionsIdentical = (actions1: any[], actions2: any[]) => {
    if (!actions1 || !actions2) return false;
    if (actions1.length !== actions2.length) return false;
    if (actions1.length === 0) return false; // Empty actions shouldn't count as repetition loop usually
    
    // Compare first action roughly
    const a1 = actions1[0];
    const a2 = actions2[0];
    return a1.type === a2.type && a1.path === a2.path && a1.content === a2.content;
};

export const runAgent = async (
  chatHistory: ChatMessage[],
  fileContext: string,
  modelId: ModelId = ModelId.GEMINI_2_5_FLASH,
  onStream?: (partial: Partial<AgentResponse>) => void,
  signal?: AbortSignal
): Promise<AgentResponse> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable is missing.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const contents: any[] = [];

  if (signal?.aborted) throw new Error("Aborted");

  try {
    let lastUserMsgIndex = -1;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'user') {
            lastUserMsgIndex = i;
            break;
        }
    }

    // Dynamic History Check for Looping
    const modelMessages = chatHistory.filter(m => m.role === 'model' && m.agentResponse);
    let isLoopingDetected = false;
    if (modelMessages.length >= 2) {
        const lastMsg = modelMessages[modelMessages.length - 1].agentResponse;
        const prevMsg = modelMessages[modelMessages.length - 2].agentResponse;
        
        if (lastMsg && prevMsg && areActionsIdentical(lastMsg.actions, prevMsg.actions)) {
            isLoopingDetected = true;
        }
    }

    for (let i = 0; i < chatHistory.length; i++) {
      const msg = chatHistory[i];
      const parts: any[] = [];
      let text = msg.content;
      
      // Inject File Context to the *last* user message
      if (i === lastUserMsgIndex) {
         text = `${text}\n\n${fileContext}`;
         
         // Inject Anti-Looping Warning if detected
         if (isLoopingDetected) {
             text += `\n\n[SYSTEM DETECTED REPETITION LOOP: You are repeating identical actions. THIS IS FORBIDDEN. You MUST change your parameters, try a different tool, or ask the user for clarification. Do NOT output the same action again.]`;
         }
      }

      if (msg.attachments && msg.attachments.length > 0) {
        text += `\n[System: Attached ${msg.attachments.length} files for analysis in this turn.]`;
      }
      parts.push({ text });
      if (msg.attachments) {
        for (const file of msg.attachments) {
          let fileContent = file.content;
          if (fileContent instanceof File) {
             if (file.size > 20 * 1024 * 1024) {
                 parts.push({ text: `\n[System: File ${file.name} is too large (>20MB) to attach to LLM context directly.]` });
                 continue;
             }
             fileContent = await resolveFileContent(file);
          }
          if (typeof fileContent === 'string') {
             parts.push({
               text: `\n--- Attached File: ${file.name} ---\n${fileContent}\n--- End Attached File ---\n`
             });
          } else if (fileContent instanceof Uint8Array) {
             const mimeType = file.mimeType || 'application/octet-stream';
             if (isGeminiSupportedMimeType(mimeType)) {
                 parts.push({ text: `[User attached file: "${file.name}"]` });
                 parts.push({
                    inlineData: {
                      mimeType: mimeType,
                      data: uint8ArrayToBase64(fileContent)
                    }
                 });
             } else {
                 parts.push({
                     text: `[System: Attached file ${file.name} has MIME type ${mimeType} which is not supported for inline analysis.]`
                 });
             }
          }
        }
      }
      if (msg.role === 'model' && msg.agentResponse) {
          parts.push({ text: JSON.stringify(msg.agentResponse) });
      }
      contents.push({
        role: msg.role === 'model' ? 'model' : 'user',
        parts: parts
      });
    }

    const MAX_RETRIES = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error("Aborted");
      try {
        const result = await ai.models.generateContentStream({
          model: modelId,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema: agentSchema,
            thinkingConfig: modelId === ModelId.GEMINI_2_5_FLASH ? { thinkingBudget: 0 } : undefined,
            safetySettings: PERMISSIVE_SAFETY_SETTINGS,
            maxOutputTokens: 4096,
          },
          contents: contents
        });

        let fullText = '';
        for await (const chunk of result) {
            if (signal?.aborted) throw new Error("Aborted");
            const textChunk = chunk.text;
            if (textChunk) {
                fullText += textChunk;
                
                // Remove Markdown code block syntax if it appears in stream
                // This helps extraction logic find JSON keys earlier
                let cleanText = fullText;
                if (cleanText.startsWith('```json')) cleanText = cleanText.replace(/^```json/, '');
                if (cleanText.startsWith('```')) cleanText = cleanText.replace(/^```/, '');
                
                if (onStream) {
                    const thought = extractJSONString(cleanText, 'thought');
                    const final_answer = extractJSONString(cleanText, 'final_answer');
                    const plan = extractJSONArray(cleanText, 'plan');
                    
                    onStream({
                        thought: thought || '',
                        final_answer: final_answer || undefined,
                        plan: plan || [],
                        actions: [], // parsing streaming actions is complex, we just wait for final JSON
                        risk_assessment: { has_destructive_actions: false, confirmation_required_ids: [] },
                        raw: fullText // Pass raw output for debugging
                    });
                }
            }
        }

        let text = fullText;
        if (!text) {
          throw new Error("Empty response from Gemini");
        }
        text = text.trim();
        if (text.startsWith('```json')) {
          text = text.replace(/^```json/, '').replace(/```$/, '');
        } else if (text.startsWith('```')) {
          text = text.replace(/^```/, '').replace(/```$/, '');
        }

        try {
          const json = JSON.parse(text) as AgentResponse;
          return json;
        } catch (e) {
          console.error(`Attempt ${attempt + 1} failed to parse JSON:`, text);
          throw new Error("Model returned invalid JSON format.");
        }

      } catch (error: any) {
        if (signal?.aborted || error.message === "Aborted") throw new Error("Aborted");

        lastError = error as Error;
        console.warn(`Attempt ${attempt + 1} failed:`, error);
        if (error.message?.includes('403') || error.status === 403 || error.message?.includes('PERMISSION_DENIED')) {
            throw new Error(`Permission Denied (403): Your API Key does not have access to model '${modelId}'.`);
        }
        if (attempt < MAX_RETRIES - 1) {
             contents.push({
                 role: 'user', 
                 parts: [{ text: "System Error: Your last response was not valid JSON. Please fix it and output STRICT valid JSON matching the schema." }]
             });
             continue; 
        }
      }
    }
    throw lastError || new Error("Failed to get valid response after retries");
  } catch (error) {
    if ((error as Error).message === "Aborted") throw error;
    console.error("Gemini API Error:", error);
    throw error;
  }
};

const extractImageFromResponse = (response: any): Uint8Array => {
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData && part.inlineData.data) {
      return base64ToUint8Array(part.inlineData.data);
    }
  }
  throw new Error("No image generated in response.");
};

export const generateImageContent = async (prompt: string, apiKey: string): Promise<Uint8Array> => {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [{ text: prompt }]
    },
    config: {
        imageConfig: { aspectRatio: "1:1" }
    }
  });
  return extractImageFromResponse(response);
};

export const editImageContent = async (prompt: string, imageBytes: Uint8Array, mimeType: string, apiKey: string): Promise<Uint8Array> => {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: mimeType,
            data: uint8ArrayToBase64(imageBytes)
          }
        },
        { text: prompt }
      ]
    }
  });
  return extractImageFromResponse(response);
};

export const composeImageContent = async (prompt: string, images: {bytes: Uint8Array, mimeType: string}[], apiKey: string): Promise<Uint8Array> => {
  const ai = new GoogleGenAI({ apiKey });
  const parts: Part[] = [];
  for (const img of images) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: uint8ArrayToBase64(img.bytes)
      }
    });
  }
  parts.push({ text: prompt });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: { parts }
  });
  return extractImageFromResponse(response);
};

export const generateVideoContent = async (prompt: string, apiKey: string, imageInput?: {bytes: Uint8Array, mimeType: string}): Promise<Uint8Array> => {
    const ai = new GoogleGenAI({ apiKey });
    const model = 'veo-3.1-fast-generate-preview';
    
    let operation;
    if (imageInput) {
        operation = await ai.models.generateVideos({
            model,
            prompt: prompt,
            image: {
                imageBytes: uint8ArrayToBase64(imageInput.bytes),
                mimeType: imageInput.mimeType
            },
            config: {
                numberOfVideos: 1
            }
        });
    } else {
        operation = await ai.models.generateVideos({
            model,
            prompt: prompt,
            config: {
                numberOfVideos: 1
            }
        });
    }

    while (!operation.done) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        operation = await ai.operations.getVideosOperation({ operation: operation });
    }

    const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
    if (!videoUri) {
        throw new Error("Video generation failed: No URI returned.");
    }
    
    const downloadUrl = `${videoUri}&key=${apiKey}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) {
        throw new Error(`Failed to download generated video: ${res.statusText}`);
    }
    const blob = await res.blob();
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
};

/**
 * Executes a Google Search using Gemini's native Grounding capabilities.
 * This runs as a separate turn to allow the 'agent' to observe the results.
 */
export const performGoogleSearch = async (query: string, apiKey: string): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey });
  
  // Use a capable model for search grounding (2.5 Flash is good and fast)
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `Please answer the following query using Google Search. Provide a summary of the findings and list the sources: "${query}"`,
    config: {
      tools: [{googleSearch: {}}],
      // We don't force JSON here, we want the natural language summary with grounding
    }
  });

  const text = response.text || "No results found.";
  const grounding = response.candidates?.[0]?.groundingMetadata;
  
  let output = `[Google Search Result for: "${query}"]\n\n${text}\n\n`;
  
  if (grounding?.groundingChunks) {
      output += "**Sources:**\n";
      grounding.groundingChunks.forEach((chunk: any, i: number) => {
          if (chunk.web) {
              output += `- [${chunk.web.title}](${chunk.web.uri})\n`;
          }
      });
  }

  return output;
};
