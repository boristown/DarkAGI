

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Download, X, Key } from 'lucide-react';
import { VirtualFile, ChatMessage, AgentAction, ActionType, ModelId, Language, UI_TEXT, AgentResponse } from './types';
import FileTree from './components/FileTree';
import ChatInterface from './components/ChatInterface';
import { handleFileUpload, generateFileTreeContext, isTextFile, resolveFileContent, getMimeType, getVideoMetadata } from './utils/fileUtils';
import { runAgent, generateImageContent, editImageContent, composeImageContent, generateVideoContent, performGoogleSearch } from './services/geminiService';
import { trimVideo } from './utils/videoUtils';
import * as math from 'mathjs';
import * as ts from 'typescript';

const App: React.FC = () => {
  const [files, setFiles] = useState<VirtualFile[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedFile, setSelectedFile] = useState<VirtualFile | null>(null);
  const [selectedFileContent, setSelectedFileContent] = useState<string | null>(null); // Async content loading state
  const [selectedFileUrl, setSelectedFileUrl] = useState<string | null>(null); // For image/video previews
  const [modelId, setModelId] = useState<ModelId>(ModelId.GEMINI_2_5_FLASH);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // Default language changed to English
  const [language, setLanguage] = useState<Language>('en');

  const abortControllerRef = useRef<AbortController | null>(null);

  const t = UI_TEXT[language];

  // Async helper to perform actions
  const performFileActions = async (currentFiles: VirtualFile[], actions: AgentAction[]): Promise<{ updatedFiles: VirtualFile[], observations: string[], observationAttachments: VirtualFile[] }> => {
     const fileMap = new Map(currentFiles.map(f => [f.path, f]));
     const observations: string[] = [];
     const observationAttachments: VirtualFile[] = [];

     // Track processed actions to prevent duplicates in the same batch
     const processedSignatures = new Set<string>();

     for (const action of actions) {
        // Create a unique signature for the logical action (ignoring ID and description)
        // Sort arrays (like source_paths) to ensure order doesn't affect uniqueness
        const signature = JSON.stringify({
            type: action.type,
            path: action.path,
            content: action.content,
            source_path: action.source_path,
            source_paths: action.source_paths ? [...action.source_paths].sort() : undefined,
            start_time: action.start_time,
            end_time: action.end_time
        });

        if (processedSignatures.has(signature)) {
            observations.push(`[System Warning] Skipped duplicate action in same batch: ${action.type} '${action.path}'. Executed once.`);
            continue;
        }
        processedSignatures.add(signature);

        try {
            switch (action.type) {
                case ActionType.READ:
                    const fileToRead = fileMap.get(action.path);
                    if (fileToRead) {
                        // LAZY LOADING LOGIC
                        // Check size metadata directly without reading content
                        const isText = isTextFile(fileToRead.name);
                        
                        // Thresholds:
                        // Inline text: < 10KB (keeps context small but useful)
                        // Attachment: Everything else, up to a limit.
                        
                        if (isText && fileToRead.size <= 10000) {
                            // Safe to resolve content to string
                            const rawContent = await resolveFileContent(fileToRead);
                            const contentStr = typeof rawContent === 'string' ? rawContent : new TextDecoder().decode(rawContent);
                            observations.push(`Action READ '${action.path}' success. Content:\n${contentStr}`);
                        } else {
                            // Attach file for multimodal analysis OR because it's too big for text logs
                            // Gemini has a 20MB limit for inline data usually, need to be careful.
                            if (fileToRead.size > 20 * 1024 * 1024) {
                                observations.push(`Action READ '${action.path}' failed: File is too large (${(fileToRead.size / 1024 / 1024).toFixed(2)}MB) for direct analysis. Please ask user to summarize or split it.`);
                            } else {
                                // We need to make sure the attachment content is loaded for the API call later
                                // But we keep it as VirtualFile (which might hold the raw File object)
                                // services/geminiService will handle reading the File object to base64
                                observationAttachments.push(fileToRead);
                                
                                let metaInfo = "";
                                if (fileToRead.mimeType?.startsWith('video/')) {
                                    try {
                                        let blob: Blob;
                                        if (fileToRead.content instanceof File) blob = fileToRead.content;
                                        else if (fileToRead.content instanceof Uint8Array) blob = new Blob([fileToRead.content], { type: fileToRead.mimeType });
                                        else blob = new Blob([], { type: fileToRead.mimeType });
                                        
                                        if (blob.size > 0) {
                                            const meta = await getVideoMetadata(blob);
                                            metaInfo = ` [Metadata: Duration=${meta.duration.toFixed(2)}s, Resolution=${meta.width}x${meta.height}]`;
                                        }
                                    } catch (e) {
                                        console.warn("Failed to extract video metadata during READ", e);
                                    }
                                }

                                observations.push(`Action READ '${action.path}' success. The file content is attached for analysis (Size: ${fileToRead.size} bytes).${metaInfo}`);
                            }
                        }
                    } else {
                        observations.push(`Action READ '${action.path}' failed: File not found.`);
                    }
                    break;
                case ActionType.WRITE:
                    if (action.content !== undefined) {
                        fileMap.set(action.path, {
                            path: action.path,
                            name: action.path.split('/').pop() || action.path,
                            content: action.content,
                            size: new TextEncoder().encode(action.content).length,
                            type: 'file',
                            lastModified: Date.now(),
                            mimeType: 'text/plain'
                        });
                        observations.push(`Action WRITE '${action.path}' success.`);
                    }
                    break;
                case ActionType.APPEND:
                    const existing = fileMap.get(action.path);
                    if (existing) {
                        // We must resolve existing content to append. 
                        // WARNING: If existing is HUGE, this will crash.
                        if (existing.size > 5 * 1024 * 1024) {
                             observations.push(`Action APPEND failed: File '${action.path}' is too large to append text directly.`);
                        } else {
                            const prevContentRaw = await resolveFileContent(existing);
                            const prevStr = typeof prevContentRaw === 'string' ? prevContentRaw : new TextDecoder().decode(prevContentRaw);
                            const newContent = prevStr + (action.content || '');
                            
                            fileMap.set(action.path, {
                                ...existing,
                                content: newContent,
                                size: new TextEncoder().encode(newContent).length,
                                lastModified: Date.now()
                            });
                            observations.push(`Action APPEND '${action.path}' success.`);
                        }
                    } else if (action.content) {
                        // New file
                        fileMap.set(action.path, {
                            path: action.path,
                            name: action.path.split('/').pop() || action.path,
                            content: action.content,
                            size: new TextEncoder().encode(action.content).length,
                            type: 'file',
                            lastModified: Date.now(),
                            mimeType: 'text/plain'
                        });
                        observations.push(`Action APPEND '${action.path}' (new file) success.`);
                    }
                    break;
                case ActionType.DELETE:
                    if (fileMap.has(action.path)) {
                        fileMap.delete(action.path);
                        observations.push(`Action DELETE '${action.path}' success.`);
                    } else {
                        observations.push(`Action DELETE '${action.path}' failed: File not found.`);
                    }
                    break;
                case ActionType.MOVE:
                    if (action.source_path && fileMap.has(action.source_path)) {
                        const source = fileMap.get(action.source_path)!;
                        fileMap.delete(action.source_path);
                        fileMap.set(action.path, {
                            ...source,
                            path: action.path,
                            name: action.path.split('/').pop() || action.path
                        });
                        observations.push(`Action MOVE '${action.source_path}' to '${action.path}' success.`);
                    } else {
                        observations.push(`Action MOVE failed: Source '${action.source_path}' not found.`);
                    }
                    break;
                case ActionType.MKDIR:
                    observations.push(`Action MKDIR '${action.path}' success (virtual).`);
                    break;
                case ActionType.GENERATE_IMAGE:
                    if (action.content) {
                         const apiKey = process.env.API_KEY || '';
                         if (!apiKey) throw new Error("Missing API Key");
                         
                         // Call service to generate image
                         const imageBytes = await generateImageContent(action.content, apiKey);
                         
                         fileMap.set(action.path, {
                             path: action.path,
                             name: action.path.split('/').pop() || action.path,
                             content: imageBytes,
                             size: imageBytes.byteLength,
                             type: 'file',
                             lastModified: Date.now(),
                             mimeType: 'image/png'
                         });
                         observations.push(`Action GENERATE_IMAGE '${action.path}' success.`);
                    } else {
                         observations.push(`Action GENERATE_IMAGE failed: Missing prompt (content).`);
                    }
                    break;
                case ActionType.EDIT_IMAGE:
                    let sourcePath = action.source_path;
                    
                    // Smart Default: If source_path is missing but there is exactly one image file, use it.
                    if (!sourcePath) {
                        const imageFiles = Array.from(fileMap.values()).filter(f => f.mimeType?.startsWith('image/'));
                        if (imageFiles.length === 1) {
                            sourcePath = imageFiles[0].path;
                            observations.push(`[System Warning] Action EDIT_IMAGE missing source_path. Auto-selected '${sourcePath}'.`);
                        }
                    }

                    if (action.content && sourcePath) {
                         const apiKey = process.env.API_KEY || '';
                         if (!apiKey) throw new Error("Missing API Key");

                         const sourceFile = fileMap.get(sourcePath);
                         if (!sourceFile) {
                             observations.push(`Action EDIT_IMAGE failed: Source file '${sourcePath}' not found.`);
                             break;
                         }
                         
                         // Resolve input image bytes
                         const rawContent = await resolveFileContent(sourceFile);
                         let inputBytes: Uint8Array;
                         if (typeof rawContent === 'string') {
                             observations.push(`Action EDIT_IMAGE failed: Source file '${sourcePath}' appears to be text, not an image.`);
                             break;
                         } else {
                             inputBytes = rawContent instanceof Uint8Array ? rawContent : new Uint8Array(rawContent);
                         }

                         const mimeType = sourceFile.mimeType || 'image/png';
                         
                         // Call service to edit image
                         try {
                            const outputBytes = await editImageContent(action.content, inputBytes, mimeType, apiKey);
                            
                            fileMap.set(action.path, {
                                path: action.path,
                                name: action.path.split('/').pop() || action.path,
                                content: outputBytes,
                                size: outputBytes.byteLength,
                                type: 'file',
                                lastModified: Date.now(),
                                mimeType: 'image/png'
                            });
                            observations.push(`Action EDIT_IMAGE '${action.path}' success.`);
                         } catch (err: any) {
                             observations.push(`Action EDIT_IMAGE failed during generation: ${err.message}`);
                         }
                    } else {
                         observations.push(`Action EDIT_IMAGE failed: Missing prompt (content) or source_path (and could not auto-detect unique image).`);
                    }
                    break;
                case ActionType.COMPOSE_IMAGE:
                    const pathsToUse = action.source_paths || (action.source_path ? [action.source_path] : []);
                    
                    if (pathsToUse.length === 0) {
                        const availableImages = Array.from(fileMap.values())
                            .filter(f => f.mimeType?.startsWith('image/'))
                            .map(f => f.path);
                        observations.push(`Action COMPOSE_IMAGE failed: No 'source_paths' provided. Available images: ${availableImages.join(', ')}`);
                        break;
                    }
                    
                    // Fallback for missing content/prompt
                    let compositionPrompt = action.content;
                    if (!compositionPrompt) {
                        if (action.description) {
                            compositionPrompt = action.description;
                            observations.push(`[System Warning] Action COMPOSE_IMAGE missing 'content'. Using description as fallback: "${compositionPrompt}"`);
                        } else {
                            compositionPrompt = "Compose these images together harmoniously.";
                            observations.push(`[System Warning] Action COMPOSE_IMAGE missing 'content'. Using default fallback: "${compositionPrompt}"`);
                        }
                    }

                    const apiKey = process.env.API_KEY || '';
                    if (!apiKey) throw new Error("Missing API Key");

                    const inputImages: { bytes: Uint8Array, mimeType: string }[] = [];
                    let hasError = false;

                    for (const p of pathsToUse) {
                        const f = fileMap.get(p);
                        if (!f) {
                            observations.push(`Action COMPOSE_IMAGE failed: File '${p}' not found.`);
                            hasError = true;
                            break;
                        }
                        
                        const raw = await resolveFileContent(f);
                        if (typeof raw === 'string') {
                             observations.push(`Action COMPOSE_IMAGE failed: File '${p}' is text, not binary.`);
                             hasError = true;
                             break;
                        }
                        
                        inputImages.push({
                            bytes: raw instanceof Uint8Array ? raw : new Uint8Array(raw),
                            mimeType: f.mimeType || 'image/png'
                        });
                    }
                    
                    if (hasError) break;

                    try {
                        const outputBytes = await composeImageContent(compositionPrompt, inputImages, apiKey);
                        
                        fileMap.set(action.path, {
                            path: action.path,
                            name: action.path.split('/').pop() || action.path,
                            content: outputBytes,
                            size: outputBytes.byteLength,
                            type: 'file',
                            lastModified: Date.now(),
                            mimeType: 'image/png'
                        });
                        observations.push(`Action COMPOSE_IMAGE '${action.path}' success.`);
                    } catch (err: any) {
                        observations.push(`Action COMPOSE_IMAGE failed: ${err.message}`);
                    }
                    break;
                case ActionType.CALCULATE_MATH:
                    if (!action.content) {
                        observations.push(`Action CALCULATE_MATH failed: Missing content (expression).`);
                        break;
                    }
                    try {
                        // Use mathjs to evaluate safely
                        const result = math.evaluate(action.content);
                        // Format the output specifically
                        const resultStr = typeof result === 'object' ? math.format(result) : String(result);
                        observations.push(`Action CALCULATE_MATH success.\nExpression: ${action.content}\nResult: ${resultStr}`);
                    } catch (err: any) {
                        observations.push(`Action CALCULATE_MATH failed: ${err.message}`);
                    }
                    break;
                case ActionType.GENERATE_VIDEO:
                     if (!action.content) {
                         observations.push(`Action GENERATE_VIDEO failed: Missing prompt in content.`);
                         break;
                     }
                     
                     const apiKeyVideo = process.env.API_KEY || '';
                     if (!apiKeyVideo) throw new Error("Missing API Key");

                     let imageInputData: { bytes: Uint8Array, mimeType: string } | undefined = undefined;
                     
                     if (action.source_path) {
                        const f = fileMap.get(action.source_path);
                        if (f) {
                             const raw = await resolveFileContent(f);
                             if (typeof raw === 'string') {
                                 observations.push(`Action GENERATE_VIDEO warning: Source file '${action.source_path}' is text, ignoring for image-to-video.`);
                             } else {
                                 imageInputData = {
                                     bytes: raw instanceof Uint8Array ? raw : new Uint8Array(raw),
                                     mimeType: f.mimeType || 'image/png'
                                 };
                             }
                        } else {
                            observations.push(`Action GENERATE_VIDEO warning: Source file '${action.source_path}' not found, proceeding with text-to-video only.`);
                        }
                     }

                     try {
                         const videoBytes = await generateVideoContent(action.content, apiKeyVideo, imageInputData);
                         
                         fileMap.set(action.path, {
                             path: action.path,
                             name: action.path.split('/').pop() || action.path,
                             content: videoBytes,
                             size: videoBytes.byteLength,
                             type: 'file',
                             lastModified: Date.now(),
                             mimeType: 'video/mp4'
                         });
                         observations.push(`Action GENERATE_VIDEO '${action.path}' success. Model: Veo.`);
                     } catch (err: any) {
                         observations.push(`Action GENERATE_VIDEO failed: ${err.message}`);
                     }
                     break;
                case ActionType.TRIM_VIDEO:
                     let startTime = action.start_time;
                     let endTime = action.end_time;
                     
                     // Fallback: Parse from content if not present (which is likely given new schema)
                     if (startTime === undefined || endTime === undefined) {
                         if (action.content) {
                             try {
                                 const params = JSON.parse(action.content);
                                 startTime = params.start;
                                 endTime = params.end;
                             } catch (e) {
                                 // Try regex if JSON parse fails
                                 const startMatch = action.content.match(/start["\s:]+(\d+(\.\d+)?)/i);
                                 const endMatch = action.content.match(/end["\s:]+(\d+(\.\d+)?)/i);
                                 if (startMatch) startTime = parseFloat(startMatch[1]);
                                 if (endMatch) endTime = parseFloat(endMatch[1]);
                             }
                         }
                     }

                     if (startTime === undefined || endTime === undefined) {
                         observations.push(`Action TRIM_VIDEO failed: Missing start/end times in 'content' JSON.`);
                         break;
                     }
                     
                     if (!action.source_path) {
                         observations.push(`Action TRIM_VIDEO failed: Missing source_path.`);
                         break;
                     }
                     
                     const videoSource = fileMap.get(action.source_path);
                     if (!videoSource) {
                         observations.push(`Action TRIM_VIDEO failed: Source file '${action.source_path}' not found.`);
                         break;
                     }
                     
                     const videoRaw = await resolveFileContent(videoSource);
                     if (typeof videoRaw === 'string') {
                          observations.push(`Action TRIM_VIDEO failed: File '${action.source_path}' is text.`);
                          break;
                     }
                     
                     try {
                         const trimmedBytes = await trimVideo(
                             videoRaw instanceof Uint8Array ? videoRaw : new Uint8Array(videoRaw),
                             videoSource.mimeType || 'video/mp4',
                             startTime,
                             endTime
                         );
                         
                         fileMap.set(action.path, {
                             path: action.path,
                             name: action.path.split('/').pop() || action.path,
                             content: trimmedBytes,
                             size: trimmedBytes.byteLength,
                             type: 'file',
                             lastModified: Date.now(),
                             mimeType: 'video/webm' // Browser MediaRecorder outputs WebM usually
                         });
                         observations.push(`Action TRIM_VIDEO '${action.path}' success. (Trimmed ${startTime}s to ${endTime}s). Note: Output is likely WebM format.`);
                     } catch(err: any) {
                         observations.push(`Action TRIM_VIDEO failed: ${err.message}`);
                     }
                     break;
                case ActionType.RUN_SCRIPT:
                    const scriptFile = fileMap.get(action.path);
                    if (!scriptFile) {
                        observations.push(`Action RUN_SCRIPT failed: File '${action.path}' not found.`);
                        break;
                    }
                    
                    let scriptContent = await resolveFileContent(scriptFile);
                    if (typeof scriptContent !== 'string') {
                        scriptContent = new TextDecoder().decode(scriptContent);
                    }

                    // Transpile TS -> JS
                    let jsCode = scriptContent;
                    try {
                        if (action.path.endsWith('.ts') || action.path.endsWith('.tsx')) {
                            // Check if ts is available from import
                            if (ts && ts.transpile) {
                                jsCode = ts.transpile(scriptContent);
                            } else {
                                observations.push(`[System Warning] TypeScript compiler not loaded. Attempting to run as raw JS.`);
                            }
                        }
                    } catch (e: any) {
                        observations.push(`Action RUN_SCRIPT transpilation failed: ${e.message}`);
                        break;
                    }

                    const logs: string[] = [];
                    const mockConsole = {
                        log: (...args: any[]) => logs.push(args.map(a => String(a)).join(' ')),
                        error: (...args: any[]) => logs.push('[Error] ' + args.map(a => String(a)).join(' ')),
                        warn: (...args: any[]) => logs.push('[Warn] ' + args.map(a => String(a)).join(' '))
                    };

                    const mockFs = {
                        read: async (p: string) => {
                             const f = fileMap.get(p);
                             if (!f) throw new Error(`File '${p}' not found`);
                             const c = await resolveFileContent(f);
                             return typeof c === 'string' ? c : new TextDecoder().decode(c);
                        },
                        write: async (p: string, c: string) => {
                             fileMap.set(p, {
                                 path: p,
                                 name: p.split('/').pop() || p,
                                 content: c,
                                 size: new TextEncoder().encode(c).length,
                                 type: 'file',
                                 lastModified: Date.now(),
                                 mimeType: 'text/plain'
                             });
                        }
                    };

                    try {
                        // Execute in async function wrapper
                        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                        const func = new AsyncFunction('console', 'fs', jsCode);
                        await func(mockConsole, mockFs);
                        
                        const logOutput = logs.length > 0 ? logs.join('\n') : '(No output)';
                        observations.push(`Action RUN_SCRIPT '${action.path}' executed successfully.\n[Console Output]:\n${logOutput}`);
                    } catch (e: any) {
                        const logOutput = logs.length > 0 ? `\n[Logs so far]:\n${logs.join('\n')}` : '';
                        observations.push(`Action RUN_SCRIPT '${action.path}' execution failed: ${e.message}${logOutput}`);
                    }
                    break;
                case ActionType.GOOGLE_SEARCH:
                    if (!action.content) {
                        observations.push(`Action GOOGLE_SEARCH failed: Missing query in content.`);
                        break;
                    }
                    const apiKeySearch = process.env.API_KEY || '';
                    if (!apiKeySearch) throw new Error("Missing API Key");

                    try {
                        const searchResult = await performGoogleSearch(action.content, apiKeySearch);
                        observations.push(searchResult);
                    } catch (err: any) {
                        observations.push(`Action GOOGLE_SEARCH failed: ${err.message}`);
                    }
                    break;
            }
        } catch (e) {
            observations.push(`Action ${action.type} on '${action.path}' failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
     }
     return { updatedFiles: Array.from(fileMap.values()), observations, observationAttachments };
  };

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        // Force immediate UI update
        setIsProcessing(false);
    }
  }, []);

  const handleSendMessage = async (text: string, incomingFiles: File[]) => {
    setIsProcessing(true);
    
    // Cancel any existing request
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // 1. Initial State Setup
    let currentFiles = [...files];
    let messageAttachments: VirtualFile[] = [];
    
    if (incomingFiles.length > 0) {
      const newFiles = await handleFileUpload(incomingFiles);
      const fileMap = new Map(currentFiles.map(f => [f.path, f]));
      newFiles.forEach(f => fileMap.set(f.path, f));
      currentFiles = Array.from(fileMap.values());
      setFiles(currentFiles); // Update UI

      // Capture new files to attach to message
      messageAttachments = newFiles;
    }

    const initialUserMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachments: messageAttachments.length > 0 ? messageAttachments : undefined
    };
    
    const conversationHistory = [...messages, initialUserMessage];
    setMessages(conversationHistory);

    // 2. Agent Loop
    const MAX_TURNS = 50; // Increased limit to support long chain of thought
    let turn = 0;
    
    try {
      while (turn < MAX_TURNS) {
        if (controller.signal.aborted) throw new Error("Aborted");

        turn++;
        const fileContext = generateFileTreeContext(currentFiles);
        
        // Setup Placeholder Model Message for Streaming
        const modelMsgId = `${Date.now()}_model_${turn}`;
        const modelMessage: ChatMessage = {
            id: modelMsgId,
            role: 'model',
            content: '', 
            agentResponse: {
                thought: 'Thinking...',
                plan: [],
                actions: [],
                risk_assessment: { has_destructive_actions: false, confirmation_required_ids: [] }
            },
            timestamp: Date.now()
        };
        
        conversationHistory.push(modelMessage);
        setMessages([...conversationHistory]); // Initial render of empty bubble

        // Streaming Callback
        const handleStreamUpdate = (partial: Partial<AgentResponse>) => {
            if (controller.signal.aborted) return;
            setMessages(prev => {
                const newMsgs = [...prev];
                const msgIdx = newMsgs.findIndex(m => m.id === modelMsgId);
                if (msgIdx !== -1) {
                    const currentResponse = newMsgs[msgIdx].agentResponse!;
                    newMsgs[msgIdx] = {
                        ...newMsgs[msgIdx],
                        agentResponse: {
                            ...currentResponse,
                            ...partial,
                            // Ensure actions array is always present even if streaming
                            actions: partial.actions || currentResponse.actions || []
                        }
                    };
                }
                return newMsgs;
            });
        };

        const agentResponse = await runAgent(conversationHistory, fileContext, modelId, handleStreamUpdate, controller.signal);
        
        if (controller.signal.aborted) throw new Error("Aborted");

        // Final Update with complete response
        setMessages(prev => {
            const newMsgs = [...prev];
            const msgIdx = newMsgs.findIndex(m => m.id === modelMsgId);
            if (msgIdx !== -1) {
                newMsgs[msgIdx] = {
                    ...newMsgs[msgIdx],
                    agentResponse: agentResponse
                };
            }
            return newMsgs;
        });

        // Sync Conversation History for next loop iteration
        // Note: The last message in conversationHistory is already the model message object reference
        // but we should update its content to match the final result for consistency.
        const lastMsg = conversationHistory[conversationHistory.length - 1];
        lastMsg.agentResponse = agentResponse;

        if (agentResponse.final_answer) {
            break; 
        }

        let observationText = '';
        let attachmentsForObservation: VirtualFile[] | undefined = undefined;

        if (agentResponse.actions && agentResponse.actions.length > 0) {
             // Now async
             const { updatedFiles, observations, observationAttachments } = await performFileActions(currentFiles, agentResponse.actions);
             currentFiles = updatedFiles;
             setFiles(currentFiles); 
             observationText = `Observation from previous actions:\n${observations.join('\n')}`;
             
             if (observationAttachments.length > 0) {
                 attachmentsForObservation = observationAttachments;
             }
        } else {
             // System Warning Logic - RELAXED
             // If model is just thinking (has thought but no action), we allow it.
             // We only warn if it output absolutely nothing useful.
             if (agentResponse.thought && agentResponse.thought.length > 10) {
                 observationText = "[System: Continue reasoning. Use tools like 'calculate_math' or 'run_script' if you need to perform calculations. Provide the final_answer when done.]";
             } else {
                 observationText = "System Warning: You did not output any actions, a substantial thought, or a final answer. You must either take an action (read/write/etc), think deeply, or provide the final_answer to complete the task.";
             }
        }

        const observationMessage: ChatMessage = {
            id: `${Date.now()}_obs_${turn}`,
            role: 'user', 
            isObservation: true,
            content: observationText,
            timestamp: Date.now(),
            attachments: attachmentsForObservation 
        };

        conversationHistory.push(observationMessage);
        setMessages([...conversationHistory]);
        
        if (turn >= MAX_TURNS) {
            const maxTurnMsg: ChatMessage = {
                id: 'max_turns',
                role: 'model',
                content: 'System: Maximum iteration limit (50) reached. Stopping execution.',
                timestamp: Date.now(),
                isError: true
            };
            setMessages(prev => [...prev, maxTurnMsg]);
        }
        
        await new Promise(r => setTimeout(r, 500));
      }

    } catch (error) {
      if ((error as Error).message === "Aborted") {
          const abortedMsg: ChatMessage = {
            id: (Date.now() + 1).toString(),
            role: 'model',
            content: t.stopped,
            timestamp: Date.now(),
            isError: true
          };
          setMessages(prev => [...prev, abortedMsg]);
      } else {
          console.error(error);
          const errorMessage: ChatMessage = {
            id: (Date.now() + 1).toString(),
            role: 'model',
            content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
            timestamp: Date.now(),
            isError: true
          };
          setMessages(prev => [...prev, errorMessage]);
      }
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  };

  const executeActions = useCallback(async (actions: AgentAction[]) => {}, []);

  const handleDeleteFile = (path: string) => {
    setFiles(prev => prev.filter(f => f.path !== path));
    if (selectedFile?.path === path) {
      setSelectedFile(null);
      setSelectedFileContent(null);
      if (selectedFileUrl) {
          URL.revokeObjectURL(selectedFileUrl);
          setSelectedFileUrl(null);
      }
    }
  };

  const handleClearChat = () => {
    setMessages([]);
  };

  const handleFileSelect = async (file: VirtualFile) => {
    // Clean up previous URL
    if (selectedFileUrl) {
        URL.revokeObjectURL(selectedFileUrl);
        setSelectedFileUrl(null);
    }
    
    setSelectedFile(file);
    setSelectedFileContent(t.previewLoading);
    
    try {
        if (file.size > 20 * 1024 * 1024) {
            setSelectedFileContent(t.previewTooLarge);
            return;
        }
        
        const mime = file.mimeType || getMimeType(file.name);
        
        if (mime.startsWith('image/') || mime.startsWith('video/')) {
            // Handle Image/Video Preview
            let blob: Blob | null = null;
            if (file.content instanceof File) {
                blob = file.content;
            } else if (file.content instanceof Uint8Array) {
                blob = new Blob([file.content], { type: mime });
            }
            
            if (blob) {
                const url = URL.createObjectURL(blob);
                setSelectedFileUrl(url);
                setSelectedFileContent(null); // Clear text content
                return;
            }
        }
        
        // Resolve content for display if it's text
        if (isTextFile(file.name)) {
            const content = await resolveFileContent(file);
            setSelectedFileContent(typeof content === 'string' ? content : new TextDecoder().decode(content));
        } else {
            setSelectedFileContent(t.previewBinary);
        }
    } catch (e) {
        setSelectedFileContent(t.previewError);
    }
    
    if (window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
  };

  const handleDownloadFile = async () => {
    if (!selectedFile) return;

    let blob: Blob;
    if (selectedFile.content instanceof File) {
        blob = selectedFile.content;
    } else {
        blob = new Blob(
            [selectedFile.content], 
            { type: selectedFile.mimeType || 'application/octet-stream' }
        );
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selectedFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // CSV Parsing Helper
  const renderCsvTable = (csvContent: string) => {
      const rows = csvContent.split(/\r?\n/).filter(r => r.trim() !== '');
      if (rows.length === 0) return <div>Empty CSV</div>;

      // Simple CSV line parser that handles basic quotes
      const parseLine = (line: string) => {
          const result = [];
          let current = '';
          let inQuotes = false;
          for (let i = 0; i < line.length; i++) {
              const char = line[i];
              if (char === '"') {
                  inQuotes = !inQuotes;
              } else if (char === ',' && !inQuotes) {
                  result.push(current);
                  current = '';
              } else {
                  current += char;
              }
          }
          result.push(current);
          return result;
      };

      const parsedRows = rows.map(r => parseLine(r));

      return (
          <div className="overflow-auto max-w-full">
              <table className="w-full text-left border-collapse text-xs">
                  <thead>
                      <tr>
                          {parsedRows[0].map((header, i) => (
                              <th key={i} className="border-b border-gray-700 bg-gray-800 p-2 font-mono text-gray-300 whitespace-nowrap sticky top-0">
                                  {header.replace(/^"|"$/g, '')}
                              </th>
                          ))}
                      </tr>
                  </thead>
                  <tbody>
                      {parsedRows.slice(1).map((row, i) => (
                          <tr key={i} className="hover:bg-gray-800/50">
                              {row.map((cell, j) => (
                                  <td key={j} className="border-b border-gray-800 p-2 text-gray-400 whitespace-nowrap max-w-xs truncate">
                                      {cell.replace(/^"|"$/g, '')}
                                  </td>
                              ))}
                          </tr>
                      ))}
                  </tbody>
              </table>
          </div>
      );
  };

  return (
    <div className="flex h-screen w-screen bg-gray-950 text-gray-100 overflow-hidden font-sans">
      
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 md:hidden backdrop-blur-sm"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <div className={`
        fixed inset-y-0 left-0 z-50 w-64 bg-gray-950 border-r border-gray-800 transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 flex flex-col
        ${isSidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}
      `}>
        <FileTree 
          files={files} 
          onSelectFile={handleFileSelect} 
          onDeleteFile={handleDeleteFile}
          selectedFilePath={selectedFile?.path} 
          language={language}
        />
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        
        <div className="flex-1 h-full relative flex flex-col">
             <ChatInterface 
               messages={messages} 
               isProcessing={isProcessing}
               onSendMessage={handleSendMessage}
               onExecuteActions={executeActions}
               onClearChat={handleClearChat}
               onStop={handleStop}
               modelId={modelId}
               setModelId={setModelId}
               onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
               language={language}
               setLanguage={setLanguage}
               files={files}
             />
        </div>

        {selectedFile && (
          <div className="absolute inset-0 md:relative md:inset-auto z-30 md:z-auto w-full md:w-96 border-l border-gray-800 bg-gray-900 flex flex-col transition-all duration-300">
             <div className="h-10 flex items-center justify-between px-4 border-b border-gray-800 bg-gray-900/50">
                <span className="text-xs font-mono text-gray-400 truncate max-w-[200px]">{selectedFile.path}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleDownloadFile}
                    className="p-1.5 text-gray-500 hover:text-blue-400 rounded-md transition-colors"
                    title={t.download}
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => { 
                        setSelectedFile(null); 
                        setSelectedFileContent(null);
                        if(selectedFileUrl) {
                            URL.revokeObjectURL(selectedFileUrl);
                            setSelectedFileUrl(null);
                        }
                    }} 
                    className="p-1.5 text-gray-500 hover:text-white rounded-md transition-colors"
                    title={t.close}
                  >
                    <span className="sr-only">{t.close}</span>
                    <X className="w-4 h-4" />
                  </button>
                </div>
             </div>
             <div className="flex-1 overflow-auto p-4 font-mono text-xs text-gray-300 whitespace-pre-wrap flex flex-col items-center items-stretch">
                {selectedFileUrl ? (
                    (selectedFile.mimeType || getMimeType(selectedFile.name)).startsWith('video/') ? (
                         <video 
                            key={selectedFileUrl}
                            src={selectedFileUrl} 
                            controls 
                            playsInline
                            className="max-w-full h-auto max-h-[60vh] rounded-lg border border-gray-700 shadow-lg" 
                         />
                    ) : (
                        <img 
                            key={selectedFileUrl}
                            src={selectedFileUrl} 
                            alt={selectedFile.name} 
                            className="max-w-full h-auto rounded-lg border border-gray-700 shadow-lg" 
                        />
                    )
                ) : (
                    selectedFileContent 
                    ? (
                        selectedFile.name.endsWith('.csv') 
                        ? renderCsvTable(selectedFileContent)
                        : (selectedFileContent.length > 10000 
                            ? (
                                <div className="w-full text-left">
                                    {selectedFileContent.slice(0, 10000)}
                                    <span className="text-gray-500 block mt-2 italic border-t border-gray-800 pt-2">
                                    ... [Content truncated due to length (>10000 chars). Download file to view full content]
                                    </span>
                                </div>
                                )
                            : <div className="w-full text-left">{selectedFileContent}</div>)
                      )
                    : t.previewLoading
                )}
             </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
