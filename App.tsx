
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Download, X } from 'lucide-react';
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
  const [selectedFileContent, setSelectedFileContent] = useState<string | null>(null);
  const [selectedFileUrl, setSelectedFileUrl] = useState<string | null>(null);
  const [modelId, setModelId] = useState<ModelId>(ModelId.GEMINI_3_FLASH);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [language, setLanguage] = useState<Language>('zh');

  const abortControllerRef = useRef<AbortController | null>(null);

  const t = UI_TEXT[language];

  const performFileActions = async (currentFiles: VirtualFile[], actions: AgentAction[]): Promise<{ updatedFiles: VirtualFile[], observations: string[], observationAttachments: VirtualFile[] }> => {
     const fileMap = new Map(currentFiles.map(f => [f.path, f]));
     const observations: string[] = [];
     const observationAttachments: VirtualFile[] = [];

     const processedSignatures = new Set<string>();

     for (const action of actions) {
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
            observations.push(`[System Warning] Skipped duplicate action: ${action.type} '${action.path}'.`);
            continue;
        }
        processedSignatures.add(signature);

        try {
            switch (action.type) {
                case ActionType.READ:
                    const fileToRead = fileMap.get(action.path);
                    if (fileToRead) {
                        const isText = isTextFile(fileToRead.name);
                        if (isText && fileToRead.size <= 10000) {
                            const rawContent = await resolveFileContent(fileToRead);
                            const contentStr = typeof rawContent === 'string' ? rawContent : new TextDecoder().decode(rawContent);
                            observations.push(`Action READ '${action.path}' success. Content:\n${contentStr}`);
                        } else {
                            if (fileToRead.size > 20 * 1024 * 1024) {
                                observations.push(`Action READ '${action.path}' failed: File is too large.`);
                            } else {
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
                                            metaInfo = ` [Metadata: Duration=${meta.duration.toFixed(2)}s, Res=${meta.width}x${meta.height}]`;
                                        }
                                    } catch (e) {}
                                }
                                observations.push(`Action READ '${action.path}' success. Content attached for analysis.${metaInfo}`);
                            }
                        }
                    } else {
                        observations.push(`Action READ '${action.path}' failed: Not found.`);
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
                            mimeType: getMimeType(action.path)
                        });
                        observations.push(`Action WRITE '${action.path}' success.`);
                    }
                    break;
                case ActionType.APPEND:
                    const existing = fileMap.get(action.path);
                    if (existing) {
                        if (existing.size > 5 * 1024 * 1024) {
                             observations.push(`Action APPEND failed: File '${action.path}' is too large.`);
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
                        fileMap.set(action.path, {
                            path: action.path,
                            name: action.path.split('/').pop() || action.path,
                            content: action.content,
                            size: new TextEncoder().encode(action.content).length,
                            type: 'file',
                            lastModified: Date.now(),
                            mimeType: 'text/plain'
                        });
                        observations.push(`Action APPEND '${action.path}' (new) success.`);
                    }
                    break;
                case ActionType.DELETE:
                    if (fileMap.has(action.path)) {
                        fileMap.delete(action.path);
                        observations.push(`Action DELETE '${action.path}' success.`);
                    } else {
                        observations.push(`Action DELETE '${action.path}' failed: Not found.`);
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
                        observations.push(`Action MOVE failed: Not found.`);
                    }
                    break;
                case ActionType.MKDIR:
                    fileMap.set(action.path, {
                        path: action.path,
                        name: action.path.split('/').pop() || action.path,
                        content: '',
                        size: 0,
                        type: 'directory',
                        lastModified: Date.now()
                    });
                    observations.push(`Action MKDIR '${action.path}' success.`);
                    break;
                case ActionType.GENERATE_IMAGE:
                    if (action.content) {
                         const apiKey = process.env.API_KEY || '';
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
                    }
                    break;
                case ActionType.CALCULATE_MATH:
                    if (action.content) {
                        try {
                            const result = math.evaluate(action.content);
                            const resultStr = typeof result === 'object' ? math.format(result) : String(result);
                            observations.push(`Action CALCULATE_MATH success. Result: ${resultStr}`);
                        } catch (err: any) {
                            observations.push(`Action CALCULATE_MATH failed: ${err.message}`);
                        }
                    }
                    break;
                case ActionType.GOOGLE_SEARCH:
                    if (action.content) {
                        const apiKeySearch = process.env.API_KEY || '';
                        const searchResult = await performGoogleSearch(action.content, apiKeySearch);
                        observations.push(searchResult);
                    }
                    break;
                case ActionType.RUN_SCRIPT:
                    const scriptFile = fileMap.get(action.path);
                    if (scriptFile) {
                        let scriptContent = await resolveFileContent(scriptFile);
                        if (typeof scriptContent !== 'string') scriptContent = new TextDecoder().decode(scriptContent);
                        let jsCode = scriptContent;
                        if (action.path.endsWith('.ts') || action.path.endsWith('.tsx')) jsCode = ts.transpile(scriptContent);
                        const logs: string[] = [];
                        const mockConsole = { log: (...a: any[]) => logs.push(a.map(x => String(x)).join(' ')) };
                        try {
                            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                            const func = new AsyncFunction('console', jsCode);
                            await func(mockConsole);
                            observations.push(`Action RUN_SCRIPT '${action.path}' success. Logs:\n${logs.join('\n')}`);
                        } catch (e: any) {
                            observations.push(`Action RUN_SCRIPT failed: ${e.message}`);
                        }
                    }
                    break;
            }
        } catch (e) {
            observations.push(`Action ${action.type} failed: ${e instanceof Error ? e.message : 'Unknown'}`);
        }
     }
     return { updatedFiles: Array.from(fileMap.values()), observations, observationAttachments };
  };

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        setIsProcessing(false);
    }
  }, []);

  const handleSendMessage = async (text: string, incomingFiles: File[]) => {
    setIsProcessing(true);
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let currentFilesState = [...files];
    let messageAttachments: VirtualFile[] = [];
    
    if (incomingFiles.length > 0) {
      const newFiles = await handleFileUpload(incomingFiles);
      const fileMap = new Map(currentFilesState.map(f => [f.path, f]));
      newFiles.forEach(f => fileMap.set(f.path, f));
      currentFilesState = Array.from(fileMap.values());
      setFiles(currentFilesState);
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

    const MAX_TURNS = 30;
    const MAX_RETRY_COUNT = 3;
    let turn = 0;
    
    // Store retry counts per path-action to prevent infinite loops on legitimate failures
    const actionRetryMap = new Map<string, number>();

    try {
      while (turn < MAX_TURNS) {
        if (controller.signal.aborted) throw new Error("Aborted");
        turn++;
        const fileContext = generateFileTreeContext(currentFilesState);
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
        setMessages([...conversationHistory]);

        const agentResponse = await runAgent(conversationHistory, fileContext, modelId, (partial) => {
            if (controller.signal.aborted) return;
            setMessages(prev => {
                const newMsgs = [...prev];
                const msgIdx = newMsgs.findIndex(m => m.id === modelMsgId);
                if (msgIdx !== -1) {
                    newMsgs[msgIdx] = {
                        ...newMsgs[msgIdx],
                        agentResponse: { ...newMsgs[msgIdx].agentResponse!, ...partial }
                    };
                }
                return newMsgs;
            });
        }, controller.signal);
        
        if (controller.signal.aborted) throw new Error("Aborted");
        setMessages(prev => {
            const newMsgs = [...prev];
            const msgIdx = newMsgs.findIndex(m => m.id === modelMsgId);
            if (msgIdx !== -1) newMsgs[msgIdx].agentResponse = agentResponse;
            return newMsgs;
        });

        conversationHistory[conversationHistory.length - 1].agentResponse = agentResponse;
        if (agentResponse.final_answer) break;

        let observationText = '';
        let attachmentsForObservation: VirtualFile[] | undefined = undefined;

        if (agentResponse.actions && agentResponse.actions.length > 0) {
             const { updatedFiles, observations, observationAttachments } = await performFileActions(currentFilesState, agentResponse.actions);
             
             // --- RETRY LOGIC VERIFICATION ---
             let retryInstructions: string[] = [];
             for (const action of agentResponse.actions) {
                 if (action.type === ActionType.WRITE || action.type === ActionType.MKDIR) {
                     const exists = updatedFiles.some(f => f.path === action.path);
                     if (!exists) {
                         const retryKey = `${action.type}:${action.path}`;
                         const currentRetries = actionRetryMap.get(retryKey) || 0;
                         if (currentRetries < MAX_RETRY_COUNT) {
                             actionRetryMap.set(retryKey, currentRetries + 1);
                             retryInstructions.push(`[CRITICAL SYSTEM] File creation failed for '${action.path}'. Action was '${action.type}'. The file is NOT present in the system. PLEASE RETRY THIS ACTION. (Attempt ${currentRetries + 1}/${MAX_RETRY_COUNT})`);
                         } else {
                             retryInstructions.push(`[CRITICAL SYSTEM] File creation failed for '${action.path}' after ${MAX_RETRY_COUNT} attempts. Please notify the user of this failure.`);
                         }
                     }
                 }
             }

             currentFilesState = updatedFiles;
             setFiles(currentFilesState); 
             
             observationText = `Observation:\n${observations.join('\n')}`;
             if (retryInstructions.length > 0) {
                 observationText += `\n\n${retryInstructions.join('\n')}`;
             }

             if (observationAttachments.length > 0) attachmentsForObservation = observationAttachments;
        } else {
             observationText = agentResponse.thought ? "[System: Please continue or finalize.]" : "[System Warning: No actions taken.]";
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
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (error) {
      if ((error as Error).message !== "Aborted") {
          setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', content: `Error: ${(error as Error).message}`, timestamp: Date.now(), isError: true }]);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const executeActions = useCallback(async (actions: AgentAction[]) => {}, []);

  const handleDeleteFile = (path: string) => {
    setFiles(prev => prev.filter(f => f.path !== path));
    if (selectedFile?.path === path) {
      setSelectedFile(null);
      setSelectedFileContent(null);
      if (selectedFileUrl) URL.revokeObjectURL(selectedFileUrl);
      setSelectedFileUrl(null);
    }
  };

  const handleClearChat = () => setMessages([]);

  const handleFileSelect = async (file: VirtualFile) => {
    if (selectedFileUrl) URL.revokeObjectURL(selectedFileUrl);
    setSelectedFile(file);
    setSelectedFileContent(t.previewLoading);
    try {
        if (file.type === 'directory') {
            setSelectedFileContent("[Directory]");
            return;
        }
        const mime = file.mimeType || getMimeType(file.name);
        if (mime.startsWith('image/') || mime.startsWith('video/')) {
            let blob = file.content instanceof File ? file.content : new Blob([file.content], { type: mime });
            setSelectedFileUrl(URL.createObjectURL(blob));
            setSelectedFileContent(null);
            return;
        }
        if (isTextFile(file.name)) {
            const content = await resolveFileContent(file);
            setSelectedFileContent(typeof content === 'string' ? content : new TextDecoder().decode(content));
        } else {
            setSelectedFileContent(t.previewBinary);
        }
    } catch (e) { setSelectedFileContent(t.previewError); }
  };

  return (
    <div className="flex h-screen w-screen bg-gray-950 text-gray-100 overflow-hidden font-sans selection:bg-indigo-500/30">
      {isSidebarOpen && <div className="fixed inset-0 bg-black/50 z-40 md:hidden backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)} />}
      <div className={`fixed inset-y-0 left-0 z-50 w-64 bg-gray-950 border-r border-gray-800 transform transition-transform duration-300 ease-in-out md:relative md:translate-x-0 flex flex-col ${isSidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}>
        <FileTree files={files} onSelectFile={handleFileSelect} onDeleteFile={handleDeleteFile} selectedFilePath={selectedFile?.path} language={language} />
      </div>
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        <div className="flex-1 h-full relative flex flex-col">
             <ChatInterface messages={messages} isProcessing={isProcessing} onSendMessage={handleSendMessage} onExecuteActions={executeActions} onClearChat={handleClearChat} onStop={handleStop} modelId={modelId} setModelId={setModelId} onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} language={language} setLanguage={setLanguage} files={files} />
        </div>
        {selectedFile && (
          <div className="absolute inset-0 md:relative md:inset-auto z-30 md:z-auto w-full md:w-96 border-l border-gray-800 bg-gray-900 flex flex-col animate-in slide-in-from-right duration-300">
             <div className="h-12 flex items-center justify-between px-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur-md">
                <span className="text-xs font-mono text-gray-400 truncate max-w-[240px]">{selectedFile.path}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => { setSelectedFile(null); if(selectedFileUrl) URL.revokeObjectURL(selectedFileUrl); }} className="p-1.5 text-gray-500 hover:text-white rounded-md transition-colors"><X className="w-4 h-4" /></button>
                </div>
             </div>
             <div className="flex-1 overflow-auto p-4 font-mono text-xs text-gray-300 whitespace-pre-wrap">
                {selectedFileUrl ? (
                    (selectedFile.mimeType || getMimeType(selectedFile.name)).startsWith('video/') 
                    ? <video src={selectedFileUrl} controls className="max-w-full rounded-lg border border-gray-700" />
                    : <img src={selectedFileUrl} alt={selectedFile.name} className="max-w-full rounded-lg border border-gray-700 shadow-xl" />
                ) : <div className="w-full text-left">{selectedFileContent}</div>}
             </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
