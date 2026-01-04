
import React, { useState } from 'react';
import { FileCode, FileText, Image as ImageIcon, Box, Trash2, Table, ChevronRight, ChevronDown, FolderOpen, Folder } from 'lucide-react';
import { VirtualFile, Language, UI_TEXT } from '../types';

interface FileTreeProps {
  files: VirtualFile[];
  onSelectFile: (file: VirtualFile) => void;
  onDeleteFile: (path: string) => void;
  selectedFilePath?: string;
  language: Language;
}

const getIcon = (file: VirtualFile) => {
  if (file.type === 'directory') return <Folder className="w-4 h-4 text-indigo-400" />;
  const fileName = file.name;
  if (fileName.endsWith('.tsx') || fileName.endsWith('.ts') || fileName.endsWith('.js') || fileName.endsWith('.jsx')) return <FileCode className="w-4 h-4 text-blue-400" />;
  if (fileName.endsWith('.css') || fileName.endsWith('.html')) return <FileCode className="w-4 h-4 text-orange-400" />;
  if (fileName.endsWith('.json')) return <FileCode className="w-4 h-4 text-yellow-400" />;
  if (fileName.endsWith('.csv')) return <Table className="w-4 h-4 text-green-400" />;
  if (fileName.match(/\.(jpg|jpeg|png|gif|svg)$/)) return <ImageIcon className="w-4 h-4 text-purple-400" />;
  if (fileName.endsWith('.zip')) return <Box className="w-4 h-4 text-red-400" />;
  return <FileText className="w-4 h-4 text-gray-400" />;
};

interface TreeNode {
    name: string;
    path: string;
    file?: VirtualFile;
    children: Record<string, TreeNode>;
}

const FileTree: React.FC<FileTreeProps> = ({ files, onSelectFile, onDeleteFile, selectedFilePath, language }) => {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['root']));
  const t = UI_TEXT[language];

  // Build tree structure
  const root: TreeNode = { name: 'root', path: '', children: {} };
  files.forEach(file => {
      const parts = file.path.split('/').filter(Boolean);
      let current = root;
      let currentPath = '';
      parts.forEach((part, index) => {
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          if (!current.children[part]) {
              current.children[part] = { name: part, path: currentPath, children: {} };
          }
          current = current.children[part];
          if (index === parts.length - 1) {
              current.file = file;
          }
      });
  });

  const toggleExpand = (path: string) => {
      const next = new Set(expandedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      setExpandedPaths(next);
  };

  const renderNode = (node: TreeNode, depth: number) => {
      const isExpanded = expandedPaths.has(node.path);
      const isDirectory = Object.keys(node.children).length > 0 || (node.file?.type === 'directory');
      const isSelected = selectedFilePath === node.path;

      if (node.name === 'root') {
          return Object.values(node.children)
            .sort((a, b) => {
                const aIsDir = Object.keys(a.children).length > 0 || (a.file?.type === 'directory');
                const bIsDir = Object.keys(b.children).length > 0 || (b.file?.type === 'directory');
                if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            .map(child => renderNode(child, 0));
      }

      return (
          <div key={node.path} className="select-none">
              <div 
                className={`group flex items-center py-1 px-2 rounded-md cursor-pointer transition-all gap-1.5 relative ${isSelected ? 'bg-indigo-500/20 text-indigo-200' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'}`}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                onClick={() => {
                    if (isDirectory) toggleExpand(node.path);
                    if (node.file) onSelectFile(node.file);
                }}
              >
                  {isDirectory && (
                      <span className="w-4 h-4 flex items-center justify-center text-gray-500">
                          {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </span>
                  )}
                  {!isDirectory && <span className="w-4" />}
                  {node.file ? getIcon(node.file) : (isExpanded ? <FolderOpen className="w-4 h-4 text-indigo-400" /> : <Folder className="w-4 h-4 text-indigo-400" />)}
                  <span className="truncate text-xs font-medium">{node.name}</span>
                  
                  {node.file && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteFile(node.path); }}
                        className="absolute right-1 opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                  )}
              </div>
              {isDirectory && isExpanded && (
                  <div className="animate-in fade-in slide-in-from-top-1 duration-200">
                      {Object.values(node.children)
                        .sort((a, b) => {
                            const aIsDir = Object.keys(a.children).length > 0 || (a.file?.type === 'directory');
                            const bIsDir = Object.keys(b.children).length > 0 || (b.file?.type === 'directory');
                            if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        })
                        .map(child => renderNode(child, depth + 1))}
                  </div>
              )}
          </div>
      );
  };

  return (
    <div className="flex flex-col h-full bg-gray-950 border-r border-gray-800 w-full flex-shrink-0">
      <div className="p-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/20 backdrop-blur-sm">
        <h2 className="text-[10px] font-bold text-indigo-400 tracking-[0.2em] uppercase">{t.workspace}</h2>
        <span className="px-1.5 py-0.5 bg-gray-800 text-gray-500 rounded text-[10px] font-mono">{files.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 scrollbar-hide">
        {files.length === 0 ? (
          <div className="text-center mt-20 text-gray-600 px-4">
            <p className="text-xs font-mono uppercase tracking-widest">{t.noFiles}</p>
            <p className="mt-4 text-[10px] leading-relaxed opacity-50">{t.uploadHint}</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {renderNode(root, 0)}
          </div>
        )}
      </div>
    </div>
  );
};

export default FileTree;
