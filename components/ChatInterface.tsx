
import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Send, Upload, Loader2, Sparkles, Terminal, ChevronDown, ChevronRight, Check, Menu, X, File as FileIcon, Trash2, Lightbulb, Eye, Zap, Globe, Square, Code, Image as ImageIcon, Film, Copy, BarChart3 } from 'lucide-react';
import { ChatMessage, AgentAction, ActionType, ModelId, Language, UI_TEXT, VirtualFile } from '../types';
import ReactMarkdown from 'react-markdown';
import { Brain } from 'lucide-react';
import { getMimeType } from '../utils/fileUtils';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface ChatInterfaceProps {
  messages: ChatMessage[];
  isProcessing: boolean;
  onSendMessage: (text: string, attachments: File[]) => void;
  onExecuteActions: (actions: AgentAction[]) => Promise<void>;
  onClearChat: () => void;
  onStop: () => void;
  modelId: ModelId;
  setModelId: (id: ModelId) => void;
  onToggleSidebar: () => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  files: VirtualFile[];
}

interface ActionCardProps {
  action: AgentAction;
  status: 'pending' | 'completed' | 'failed';
  files: VirtualFile[];
}

const UserAttachment: React.FC<{ file: VirtualFile }> = ({ file }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const mime = file.mimeType || getMimeType(file.name);
  const isImage = mime.startsWith('image/');

  useEffect(() => {
    if (!isImage) return;
    let blob: Blob | null = null;
    if (file.content instanceof File) blob = file.content;
    else if (file.content instanceof Uint8Array) blob = new Blob([file.content], { type: mime });
    if (blob) {
      const url = URL.createObjectURL(blob);
      setObjectUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [file, isImage, mime]);

  if (isImage && objectUrl) {
    return (
      <div className="relative group block mt-2 mr-2">
        <div className="overflow-hidden rounded-lg border border-gray-700 bg-black/20">
            <img src={objectUrl} alt={file.name} className="max-h-64 max-w-full object-contain" />
        </div>
        <div className="text-[10px] text-gray-400 mt-1 flex items-center gap-1 px-1">
            <ImageIcon className="w-3 h-3" />
            <span className="truncate max-w-[200px]">{file.name}</span>
        </div>
      </div>
    );
  }
  return (
    <span className="text-xs bg-gray-900/50 px-2.5 py-1.5 rounded-md text-gray-300 flex items-center gap-2 border border-gray-700/50 group-hover:border-gray-600/50 transition-colors">
        <FileIcon className="w-3.5 h-3.5 text-purple-400" />
        <span className="truncate max-w-[150px]">{file.name}</span>
    </span>
  );
};

const InlineFilePreview: React.FC<{ path: string, files: VirtualFile[] }> = ({ path, files }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [fileType, setFileType] = useState<'image' | 'video' | null>(null);
  const file = useMemo(() => files.find(f => f.path === path), [files, path]);

  useEffect(() => {
    if (!file) { setObjectUrl(null); return; }
    const mime = file.mimeType || getMimeType(file.name);
    let blob: Blob | null = null;
    if (file.content instanceof File) blob = file.content;
    else if (file.content instanceof Uint8Array) blob = new Blob([file.content], { type: mime });
    if (blob) {
        const url = URL.createObjectURL(blob);
        setObjectUrl(url);
        if (mime.startsWith('image/')) setFileType('image');
        else if (mime.startsWith('video/')) setFileType('video');
        else setFileType(null);
        return () => URL.revokeObjectURL(url);
    }
  }, [file, path, files]);

  if (!objectUrl || !fileType) return null;
  return (
    <div className="mt-3 rounded-lg overflow-hidden border border-gray-800 bg-black/20 inline-block max-w-full">
        {fileType === 'image' && <img src={objectUrl} alt={path} className="max-h-64 object-contain" />}
        {fileType === 'video' && <video src={objectUrl} controls className="max-h-64 max-w-full" />}
        <div className="px-3 py-1.5 bg-gray-900/80 text-[10px] text-gray-400 font-mono flex items-center gap-2 border-t border-gray-800">
            {fileType === 'image' ? <ImageIcon className="w-3 h-3" /> : <Film className="w-3 h-3" />}
            {path}
        </div>
    </div>
  );
};

const ActionCard: React.FC<ActionCardProps> = ({ action, status, files }) => {
  const getBadgeColor = (type: ActionType) => {
    switch (type) {
      case ActionType.WRITE: return 'bg-green-500/10 text-green-400 border-green-500/20';
      case ActionType.DELETE: return 'bg-red-500/10 text-red-400 border-red-500/20';
      case ActionType.READ: return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      case ActionType.GENERATE_IMAGE:
      case ActionType.EDIT_IMAGE:
      case ActionType.COMPOSE_IMAGE: return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
      case ActionType.GENERATE_VIDEO:
      case ActionType.TRIM_VIDEO: return 'bg-pink-500/10 text-pink-400 border-pink-500/20';
      default: return 'bg-gray-500/10 text-gray-400 border-gray-500/20';
    }
  };
  const isMediaAction = [ActionType.GENERATE_IMAGE, ActionType.EDIT_IMAGE, ActionType.COMPOSE_IMAGE, ActionType.GENERATE_VIDEO, ActionType.TRIM_VIDEO].includes(action.type);

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-900/50 border border-gray-800/50 mb-2 font-mono text-xs">
      <div className={`mt-0.5 w-4 h-4 flex items-center justify-center rounded-full ${status === 'completed' ? 'bg-green-500/20 text-green-400' : 'bg-gray-700 text-gray-500'}`}>
        {status === 'completed' && <Check className="w-3 h-3" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={`px-1.5 py-0.5 rounded border uppercase text-[10px] font-bold ${getBadgeColor(action.type)}`}>{action.type}</span>
          <span className="text-gray-300 break-all">{action.path}</span>
        </div>
        {action.description && <p className="text-gray-500">{action.description}</p>}
        {action.content && action.type !== ActionType.READ && !isMediaAction && (
          <div className="mt-2 p-2 bg-gray-950 rounded border border-gray-800 text-gray-400 overflow-hidden max-h-20 text-[10px] whitespace-pre-wrap">
            {action.content.slice(0, 100)}...
          </div>
        )}
        {status === 'completed' && isMediaAction && <InlineFilePreview path={action.path} files={files} />}
      </div>
    </div>
  );
};

const CodeRenderer = ({ node, inline, className, children, ...props }: any) => {
    const [isCopied, setIsCopied] = useState(false);
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : 'text';
    const codeString = String(children).replace(/\n$/, '');
    const handleCopy = async () => {
        await navigator.clipboard.writeText(codeString);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
    };
    if (inline) return <code className="bg-gray-800/80 text-purple-300 px-1.5 py-0.5 rounded text-[13px] font-mono border border-gray-700/50" {...props}>{children}</code>;
    return (
        <div className="relative group my-4 rounded-lg overflow-hidden border border-gray-800 bg-[#1e1e1e] shadow-lg">
            <div className="flex items-center justify-between px-3 py-1.5 bg-[#252526] border-b border-gray-700/30">
                <span className="text-[10px] font-mono text-gray-400 uppercase tracking-wider">{language}</span>
                <button onClick={handleCopy} className="flex items-center gap-1.5 text-[10px] text-gray-400 hover:text-white transition-colors p-1 rounded hover:bg-gray-700/50 active:scale-95" title="Copy to clipboard">
                    {isCopied ? <><Check className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400 font-medium">Copied!</span></> : <><Copy className="w-3.5 h-3.5" /><span>Copy</span></>}
                </button>
            </div>
            <div className="overflow-x-auto">
                <SyntaxHighlighter style={vscDarkPlus} language={language} PreTag="div" customStyle={{ margin: 0, padding: '1rem', background: 'transparent' }} showLineNumbers={true} lineNumberStyle={{ minWidth: '2em', paddingRight: '1em', color: '#6e7681', textAlign: 'right' }} wrapLines={true} {...props}>
                    {codeString}
                </SyntaxHighlighter>
            </div>
        </div>
    );
};

const AgentResponseBubble = ({ message, onExecute, t, isLatest, files }: { message: ChatMessage, onExecute: (actions: AgentAction[]) => void, t: any, isLatest: boolean, files: VirtualFile[] }) => {
  const [isThoughtExpanded, setIsThoughtExpanded] = useState(!message.agentResponse?.final_answer || isLatest); 
  const [isRawExpanded, setIsRawExpanded] = useState(false);
  const { agentResponse } = message;
  if (!agentResponse) return null;
  const hasActions = agentResponse.actions && agentResponse.actions.length > 0;
  const hasAnswer = !!agentResponse.final_answer;
  const hasPlan = agentResponse.plan && agentResponse.plan.length > 0;
  const hasRaw = !!agentResponse.raw; 

  const markdownComponents = {
    code: CodeRenderer,
    h1: ({children}: any) => <h1 className="text-xl font-bold text-gray-100 mb-4 mt-6 pb-2 border-b border-gray-800">{children}</h1>,
    h2: ({children}: any) => <h2 className="text-lg font-bold text-gray-200 mb-3 mt-5">{children}</h2>,
    h3: ({children}: any) => <h3 className="text-md font-semibold text-gray-300 mb-2 mt-4">{children}</h3>,
    ul: ({children}: any) => <ul className="list-disc pl-5 mb-4 space-y-1 text-gray-300">{children}</ul>,
    ol: ({children}: any) => <ol className="list-decimal pl-5 mb-4 space-y-1 text-gray-300">{children}</ol>,
    a: ({href, children}: any) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{children}</a>,
    blockquote: ({children}: any) => <blockquote className="border-l-4 border-gray-700 pl-4 italic text-gray-400 my-4">{children}</blockquote>
  };

  return (
    <div className="flex flex-col gap-4 w-full max-w-3xl animate-fade-in">
      {agentResponse.thought && (
      <div className="bg-gray-800/30 border border-gray-700/50 rounded-xl overflow-hidden">
        <button onClick={() => setIsThoughtExpanded(!isThoughtExpanded)} className="w-full flex items-center gap-2 px-4 py-3 bg-gray-800/50 hover:bg-gray-800 transition-colors text-left">
          <Brain className="w-4 h-4 text-purple-400 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-300">{t.thoughtProcess}</span>
          <div className="flex-1" />
          <span className="text-xs text-gray-500 mr-2 truncate max-w-[200px]">{agentResponse.thought.slice(0, 50)}...</span>
          {isThoughtExpanded ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
        </button>
        {isThoughtExpanded && (
          <div className="p-4 text-gray-300 text-sm leading-relaxed border-t border-gray-700/50 bg-gray-900/40 font-mono text-[13px]">
            <ReactMarkdown components={markdownComponents}>{agentResponse.thought}</ReactMarkdown>
            {isLatest && !hasActions && !hasAnswer && <span className="inline-block w-2 h-4 bg-purple-500 ml-1 animate-pulse align-middle"></span>}
          </div>
        )}
      </div>
      )}
      {(hasActions || hasAnswer || hasPlan) && (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-10">{hasActions ? <Terminal className="w-24 h-24" /> : <Sparkles className="w-24 h-24" />}</div>
        {hasAnswer && (
            <div className="mb-6 relative z-10">
                <h3 className="text-sm font-semibold text-emerald-400 mb-3 flex items-center gap-2"><Lightbulb className="w-4 h-4" />{t.finalAnswer}</h3>
                <div className="text-gray-200 text-sm leading-7 prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown components={markdownComponents}>{(agentResponse.final_answer || '').length > 10000 ? (agentResponse.final_answer || '').slice(0, 10000) + '\n\n... [Content truncated (>10000 chars)]' : (agentResponse.final_answer || '')}</ReactMarkdown>
                </div>
            </div>
        )}
        {hasPlan && !hasActions && !hasAnswer && (
             <div className="mb-6 relative z-10">
                <h3 className="text-sm font-semibold text-blue-400 mb-3 flex items-center gap-2"><Terminal className="w-4 h-4" />Planning...</h3>
                 <ul className="space-y-2">{agentResponse.plan.map((step, idx) => (<li key={idx} className="flex items-start gap-2 text-sm text-gray-400 animate-fade-in"><span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-500/50 flex-shrink-0" /><span>{step}</span></li>))}</ul>
             </div>
        )}
        {hasActions && (
          <>
             {hasAnswer && <div className="h-px bg-gray-800 my-5" />}
             <h3 className="text-sm font-semibold text-blue-400 mb-4 flex items-center gap-2 relative z-10"><Terminal className="w-4 h-4" />{t.executedActions}</h3>
             <ul className="space-y-2 mb-6 relative z-10">{agentResponse.plan.map((step, idx) => (<li key={idx} className="flex items-start gap-2 text-sm text-gray-400"><span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-500/50 flex-shrink-0" /><span>{step}</span></li>))}</ul>
            <div className="border-t border-gray-800 pt-4 mb-4 relative z-10">{agentResponse.actions.map((action, idx) => (<ActionCard key={action.id} action={action} status={'completed'} files={files} />))}</div>
          </>
        )}
      </div>
      )}
      {hasRaw && (
        <div className="bg-black/30 border border-gray-800 rounded-lg overflow-hidden mt-2">
             <button onClick={() => setIsRawExpanded(!isRawExpanded)} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 transition-colors">
                <Code className="w-3 h-3" /><span>{t.rawOutput}</span><span className="text-[10px] bg-gray-800/50 px-1.5 py-0.5 rounded ml-2 border border-gray-700/30 text-gray-600">{agentResponse.raw?.length.toLocaleString()} chars</span>
                <div className="flex-1" />{isRawExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
             </button>
             {isRawExpanded && <div className="p-3 bg-black/50 border-t border-gray-800 font-mono text-[10px] text-gray-400 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">{agentResponse.raw}</div>}
        </div>
      )}
    </div>
  );
};

const ChatInterface: React.FC<ChatInterfaceProps> = ({ messages, isProcessing, onSendMessage, onClearChat, onStop, modelId, setModelId, onToggleSidebar, language, setLanguage, files }) => {
  const [input, setInput] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const t = UI_TEXT[language];
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isProcessing]);
  useEffect(() => { if (textareaRef.current) { textareaRef.current.style.height = 'auto'; textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 128) + 'px'; } }, [input]);
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => { if (e.target.files && e.target.files.length > 0) { setPendingFiles(prev => [...prev, ...Array.from(e.target.files!)]); } setTimeout(() => { if (fileInputRef.current) fileInputRef.current.value = ''; }, 0); };
  const removePendingFile = (index: number) => setPendingFiles(prev => prev.filter((_, i) => i !== index));
  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (isProcessing) { onStop(); return; } if (!input.trim() && pendingFiles.length === 0) return; onSendMessage(input, pendingFiles); setInput(''); setPendingFiles([]); if (textareaRef.current) textareaRef.current.style.height = 'auto'; };
  const currentRawLength = useMemo(() => { if (!isProcessing) return 0; const lastMsg = messages[messages.length - 1]; if (lastMsg && lastMsg.role === 'model' && lastMsg.agentResponse) return lastMsg.agentResponse.raw?.length || 0; return 0; }, [messages, isProcessing]);

  return (
    <div className="flex flex-col h-full w-full bg-gray-900 relative">
      <div className="h-16 border-b border-gray-800 flex items-center justify-between px-4 bg-gray-900/95 backdrop-blur-sm sticky top-0 z-20 shadow-md">
        <div className="flex items-center gap-3">
            <button onClick={onToggleSidebar} className="md:hidden p-2 -ml-2 text-gray-400 hover:text-white"><Menu className="w-5 h-5" /></button>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gray-900 via-indigo-900 to-purple-900 flex items-center justify-center text-white shadow-[0_0_15px_rgba(99,102,241,0.25)] border border-indigo-500/30 relative overflow-hidden group transition-all hover:shadow-[0_0_25px_rgba(139,92,246,0.5)] hover:border-indigo-400/50">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.1),transparent_70%)]"></div>
                <svg viewBox="0 0 24 24" className="w-6 h-6 text-white drop-shadow-md transform group-hover:scale-110 transition-transform duration-300" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2L4 13h6l-2 9" className="text-indigo-400" strokeWidth="3" /><path d="M10 2c5 0 9 4.5 9 10s-4 10-9 10" className="opacity-90" /></svg>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-1.5 hidden sm:flex">
                <h1 className="font-display font-bold text-xl text-transparent bg-clip-text bg-gradient-to-r from-gray-100 to-gray-400 tracking-wide">{t.appName}</h1>
                <span className="text-[11px] font-normal text-gray-500 whitespace-nowrap">{t.brandSuffix}</span>
                <span className="text-[10px] bg-indigo-900/40 text-indigo-300 px-1.5 py-0.5 rounded-sm border border-indigo-500/30 font-mono ml-1 tracking-tighter self-center">{t.version}</span>
            </div>
        </div>
        <div className="flex items-center gap-3">
            <button onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')} className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-all border border-transparent hover:border-gray-700" title={language === 'zh' ? 'Switch to English' : '切换到中文'}><Globe className="w-3.5 h-3.5" /><span>{language === 'zh' ? 'EN' : '中'}</span></button>
            <button onClick={onClearChat} className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-all" title={t.resetSession}><Trash2 className="w-4 h-4" /></button>
            <div className="h-4 w-px bg-gray-800 mx-1"></div>
            <div className="relative group">
                <select value={modelId} onChange={(e) => setModelId(e.target.value as ModelId)} className="appearance-none bg-gray-800 border border-gray-700 text-gray-300 text-xs font-medium rounded-lg pl-3 pr-8 py-2 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500/50 transition-all hover:bg-gray-750 cursor-pointer min-w-[140px]">
                    <option value={ModelId.GEMINI_3_FLASH}>Gemini 3.0 Flash (Default)</option>
                    <option value={ModelId.GEMINI_3_PRO}>Gemini 3.0 Pro (Preview)</option>
                    <option value={ModelId.GEMINI_2_5_FLASH}>Gemini 2.5 Flash</option>
                    <option value={ModelId.GEMINI_2_5_FLASH_LITE}>Gemini 2.5 Flash Lite</option>
                    <option value={ModelId.GEMINI_ROBOTICS}>Gemini Robotics</option>
                </select>
                <ChevronDown className="w-3 h-3 text-gray-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none group-hover:text-gray-300 transition-colors" />
            </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 md:space-y-8 scroll-smooth">
        {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-gray-600 space-y-6 px-4 animate-fade-in-up">
                <div className="relative group"><div className="absolute inset-0 bg-purple-500/30 blur-3xl rounded-full opacity-50 group-hover:opacity-70 transition-opacity duration-1000"></div><div className="bg-gray-900/50 p-6 rounded-2xl border border-gray-800/50 relative backdrop-blur-sm"><svg viewBox="0 0 24 24" className="w-12 h-12 text-purple-400 relative z-10 drop-shadow-[0_0_15px_rgba(168,85,247,0.5)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2L4 13h6l-2 9" /><path d="M10 2c5 0 9 4.5 9 10s-4 10-9 10" /></svg></div></div>
                <div className="text-center space-y-3"><h2 className="font-display text-3xl font-bold text-gray-200 tracking-tight">{t.initializeTitle}</h2><p className="text-sm text-gray-500 max-w-sm mx-auto font-mono leading-relaxed">{t.initializeDesc}</p></div>
            </div>
        )}
        {messages.map((msg, index) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' && !msg.isObservation ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'user' && !msg.isObservation && (<div className="bg-gradient-to-br from-gray-800 to-gray-800/80 text-gray-100 rounded-2xl rounded-tr-sm px-5 py-3.5 max-w-[90%] md:max-w-xl text-sm leading-relaxed shadow-lg border border-gray-700/50 group"><div className="whitespace-pre-wrap">{msg.content}</div>{msg.attachments && msg.attachments.length > 0 && (<div className="mt-3 pt-3 border-t border-gray-700/50 flex flex-wrap gap-2">{msg.attachments.map((f, i) => (<UserAttachment key={i} file={f} />))}</div>)}</div>)}
            {msg.role === 'user' && msg.isObservation && (<div className="flex gap-4 max-w-3xl w-full pl-2"><div className="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center flex-shrink-0 border border-gray-800 relative"><div className="absolute inset-0 bg-blue-500/5 rounded-lg"></div><Eye className="w-4 h-4 text-gray-500" /></div><div className="flex-1 bg-gray-950/30 border border-gray-800/50 rounded-lg p-3 font-mono text-[11px] text-gray-400 whitespace-pre-wrap leading-relaxed shadow-inner"><span className="text-blue-500/80 font-bold mr-2">{t.systemObservation}:</span>{msg.content.length > 10000 ? msg.content.slice(0, 10000) + '... [Truncated]' : msg.content}</div></div>)}
            {msg.role === 'model' && (<div className="w-full max-w-3xl">{msg.agentResponse ? (<AgentResponseBubble message={msg} onExecute={() => {}} t={t} isLatest={index === messages.length - 1 && isProcessing} files={files} />) : (<div className={`text-xs md:text-sm p-4 border rounded-lg backdrop-blur-sm ${msg.isError && msg.content.includes(t.stopped) ? 'text-yellow-400 bg-yellow-900/10 border-yellow-900/20' : 'text-red-400 bg-red-900/10 border-red-900/20'}`}><span className="font-bold">{msg.isError && msg.content.includes(t.stopped) ? 'System' : t.systemError}:</span> {msg.content}</div>)}</div>)}
          </div>
        ))}
        {isProcessing && (<div className="flex justify-start animate-fade-in pl-2"><div className="bg-gray-900/60 rounded-full px-5 py-3 flex items-center gap-3 border border-purple-500/20 shadow-[0_0_15px_rgba(168,85,247,0.1)]"><Loader2 className="w-4 h-4 animate-spin text-purple-500" /><div className="flex flex-col"><span className="text-xs font-mono text-purple-300/80 tracking-wide">{t.processing}</span>{currentRawLength > 0 && (<div className="flex items-center gap-1.5 mt-0.5"><BarChart3 className="w-3 h-3 text-gray-500" /><span className="text-[10px] font-mono text-gray-500">Length: {currentRawLength.toLocaleString()} chars</span></div>)}</div></div></div>)}
        <div ref={bottomRef} className="h-4" />
      </div>
      <div className="p-3 md:p-4 border-t border-gray-800 bg-gray-900/95 backdrop-blur z-20 pb-safe">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto flex flex-col gap-2 bg-gray-800/80 p-2.5 rounded-2xl border border-gray-700/50 shadow-2xl focus-within:border-purple-500/50 focus-within:ring-1 focus-within:ring-purple-500/20 transition-all duration-300">
          {pendingFiles.length > 0 && (<div className="flex gap-2 overflow-x-auto pb-2 px-1 scrollbar-hide">{pendingFiles.map((file, idx) => (<div key={idx} className="flex-shrink-0 flex items-center gap-2 bg-gray-700/50 pl-3 pr-2 py-1.5 rounded-lg text-xs text-gray-300 border border-gray-600/30"><span className="truncate max-w-[120px]">{file.name}</span><button type="button" onClick={() => removePendingFile(idx)} className="p-0.5 hover:bg-gray-600 rounded-full text-gray-400 hover:text-white transition-colors"><X className="w-3 h-3" /></button></div>))}</div>)}
          <div className="flex items-end gap-2.5">
            <input type="file" multiple ref={fileInputRef} className="hidden" onChange={handleFileSelect} />
            <button type="button" onClick={() => fileInputRef.current?.click()} className="p-3 text-gray-400 hover:text-purple-400 hover:bg-gray-700/50 rounded-xl transition-all active:scale-95 group" title={t.uploadHint} disabled={isProcessing}><Upload className="w-5 h-5 group-hover:scale-110 transition-transform" /></button>
            <textarea ref={textareaRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } }} placeholder={t.enterCommand} className="flex-1 bg-transparent border-none outline-none text-gray-200 text-sm min-h-[44px] max-h-32 py-3 px-1 resize-none placeholder-gray-500/70 leading-relaxed font-medium" rows={1} />
            <button type={isProcessing ? "button" : "submit"} disabled={!isProcessing && (!input.trim() && pendingFiles.length === 0)} className={`p-3 rounded-xl transition-all shadow-lg active:scale-95 flex items-center justify-center ${isProcessing ? 'bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/50 shadow-red-900/20' : 'bg-gradient-to-br from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-purple-900/20 disabled:opacity-50 disabled:grayscale disabled:shadow-none'}`} title={isProcessing ? t.stop : undefined}>{isProcessing ? <Square className="w-5 h-5 fill-current" /> : <Send className="w-5 h-5" />}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ChatInterface;
