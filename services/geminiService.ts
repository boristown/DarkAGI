
import { GoogleGenAI, Schema, Type, HarmCategory, HarmBlockThreshold, Part } from "@google/genai";
import { AgentResponse, ModelId, VirtualFile, ChatMessage } from "../types";
import { uint8ArrayToBase64, isGeminiSupportedMimeType, resolveFileContent, base64ToUint8Array } from "../utils/fileUtils";

const PERMISSIVE_SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const agentSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    thought: { type: Type.STRING, description: "Logical reasoning (1-2 sentences)." },
    final_answer: { type: Type.STRING, description: "Final Markdown response for the user." },
    plan: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Steps being taken." },
    risk_assessment: {
      type: Type.OBJECT,
      properties: {
        has_destructive_actions: { type: Type.BOOLEAN },
        confirmation_required_ids: { type: Type.ARRAY, items: { type: Type.STRING } }
      },
      required: ["has_destructive_actions", "confirmation_required_ids"]
    },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          type: {
            type: Type.STRING,
            enum: ["read", "write", "append", "move", "delete", "mkdir", "generate_image", "edit_image", "compose_image", "calculate_math", "generate_video", "trim_video", "run_script", "google_search"]
          },
          path: { type: Type.STRING },
          content: { type: Type.STRING },
          source_path: { type: Type.STRING },
          source_paths: { type: Type.ARRAY, items: { type: Type.STRING } },
          description: { type: Type.STRING }
        },
        required: ["id", "type", "path"]
      }
    }
  },
  required: ["thought", "plan", "actions", "risk_assessment"]
};

const SYSTEM_INSTRUCTION = `
You are "DarkAGI v2.4", powered by DeepShare (深度之眼). An Advanced Autonomous Agent.

## PROJECT WORKFLOW
1. **MKDIR FIRST**: If you are building a complex project structure, you MUST create directories using \`mkdir\` before writing files into them.
2. **INCREMENTAL WRITE**: Create source files one by one to avoid huge JSON payloads that might be truncated.
3. **READ TO KNOW**: Use \`read\` to see contents of existing files, images, or videos. You are natively multimodal.
4. **NO HALLUCINATION**: If the user asks for a calculation, use \`calculate_math\`. If they want news, use \`google_search\`. Do NOT guess.

## VIRTUAL FILE SYSTEM
The workspace is virtual. Files persist across turns. Use \`read\` to verify what you wrote if needed.

## OUTPUT RULES
- ALWAYS valid JSON.
- thoughts should be concise but clear.
- final_answer is only for communicating results to the human.
`;

const extractJSONString = (text: string, propName: string): string | null => {
    const regex = new RegExp(`"${propName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s");
    const match = text.match(regex);
    if (match) {
        return match[1].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    const regexPartial = new RegExp(`"${propName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "s");
    const matchPartial = text.match(regexPartial);
    if (matchPartial) {
        return matchPartial[1].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return null;
};

const extractJSONArray = (text: string, propName: string): string[] => {
    const regex = new RegExp(`"${propName}"\\s*:\\s*\\[(.*?)(?:\\]|$)`, "s");
    const match = text.match(regex);
    if (match) {
        const items = match[1].match(/"((?:[^"\\\\]|\\\\.)*)"/g);
        if (items) return items.map(i => i.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    }
    return [];
};

export const runAgent = async (
  chatHistory: ChatMessage[],
  fileContext: string,
  modelId: ModelId = ModelId.GEMINI_3_FLASH,
  onStream?: (partial: Partial<AgentResponse>) => void,
  signal?: AbortSignal
): Promise<AgentResponse> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API_KEY missing.");
  const ai = new GoogleGenAI({ apiKey });
  const contents: any[] = [];
  try {
    let lastUserMsgIndex = -1;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      if (chatHistory[i].role === 'user') {
        lastUserMsgIndex = i;
        break;
      }
    }
    
    for (let i = 0; i < chatHistory.length; i++) {
      const msg = chatHistory[i];
      let text = msg.content;
      if (i === lastUserMsgIndex) text = `${text}\n\n${fileContext}`;
      const parts: Part[] = [{ text }];
      if (msg.attachments) {
        for (const file of msg.attachments) {
          const fileContent = await resolveFileContent(file);
          if (typeof fileContent === 'string') parts.push({ text: `\nFile: ${file.name}\n${fileContent}\n` });
          else if (isGeminiSupportedMimeType(file.mimeType || '')) {
             parts.push({ inlineData: { mimeType: file.mimeType!, data: uint8ArrayToBase64(fileContent as Uint8Array) } });
          }
        }
      }
      if (msg.role === 'model' && msg.agentResponse) parts.push({ text: JSON.stringify(msg.agentResponse) });
      contents.push({ role: msg.role === 'model' ? 'model' : 'user', parts });
    }

    // Set budget based on model series
    let thinkingBudget = 0;
    if (modelId === ModelId.GEMINI_3_PRO) thinkingBudget = 32768;
    else if (modelId === ModelId.GEMINI_3_FLASH) thinkingBudget = 24576;

    const result = await ai.models.generateContentStream({
      model: modelId,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: agentSchema,
        thinkingConfig: thinkingBudget > 0 ? { thinkingBudget } : undefined,
        safetySettings: PERMISSIVE_SAFETY_SETTINGS,
      },
      contents: contents
    });

    let fullText = '';
    for await (const chunk of result) {
        if (signal?.aborted) throw new Error("Aborted");
        fullText += chunk.text || '';
        let cleanText = fullText.replace(/^```json/, '').replace(/^```/, '');
        if (onStream) {
            onStream({
                thought: extractJSONString(cleanText, 'thought') || '',
                final_answer: extractJSONString(cleanText, 'final_answer') || undefined,
                plan: extractJSONArray(cleanText, 'plan') || [],
                raw: fullText
            });
        }
    }
    let text = fullText.trim().replace(/^```json/, '').replace(/```$/, '').replace(/^```/, '');
    return JSON.parse(text) as AgentResponse;
  } catch (error) { throw error; }
};

export const generateImageContent = async (prompt: string, apiKey: string): Promise<Uint8Array> => {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({ model: 'gemini-2.5-flash-image', contents: { parts: [{ text: prompt }] } });
  const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
  if (part?.inlineData) return base64ToUint8Array(part.inlineData.data);
  throw new Error("Generation failed.");
};

export const performGoogleSearch = async (query: string, apiKey: string): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({ 
    model: 'gemini-3-flash-preview', 
    contents: query, 
    config: { tools: [{googleSearch: {}}] } 
  });
  let out = `${response.text}\n\n**Sources:**\n`;
  response.candidates?.[0]?.groundingMetadata?.groundingChunks?.forEach((c: any) => { if(c.web) out += `- [${c.web.title}](${c.web.uri})\n`; });
  return out;
};

export const generateVideoContent = async (prompt: string, apiKey: string, imageInput?: {bytes: Uint8Array, mimeType: string}): Promise<Uint8Array> => {
    const ai = new GoogleGenAI({ apiKey });
    let op = await ai.models.generateVideos({ model: 'veo-3.1-fast-generate-preview', prompt, config: { numberOfVideos: 1 } });
    while (!op.done) { await new Promise(r => setTimeout(r, 10000)); op = await ai.operations.getVideosOperation({ operation: op }); }
    const res = await fetch(`${op.response?.generatedVideos?.[0]?.video?.uri}&key=${apiKey}`);
    return new Uint8Array(await (await res.blob()).arrayBuffer());
};

export const editImageContent = async (prompt: string, bytes: Uint8Array, mime: string, key: string) => {
    const ai = new GoogleGenAI({ apiKey: key });
    const parts: Part[] = [
      { inlineData: { mimeType: mime, data: uint8ArrayToBase64(bytes) } },
      { text: prompt }
    ];
    const response = await ai.models.generateContent({ 
      model: 'gemini-2.5-flash-image', 
      contents: { parts } 
    });
    const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
    if (part?.inlineData) return base64ToUint8Array(part.inlineData.data);
    throw new Error("Edit failed.");
};

export const composeImageContent = async (prompt: string, imgs: {bytes: Uint8Array, mimeType: string}[], key: string) => {
    const ai = new GoogleGenAI({ apiKey: key });
    const parts: Part[] = [
      ...imgs.map(i => ({ inlineData: { mimeType: i.mimeType, data: uint8ArrayToBase64(i.bytes) } })),
      { text: prompt }
    ];
    const response = await ai.models.generateContent({ 
      model: 'gemini-2.5-flash-image', 
      contents: { parts } 
    });
    const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
    if (part?.inlineData) return base64ToUint8Array(part.inlineData.data);
    throw new Error("Compose failed.");
};
