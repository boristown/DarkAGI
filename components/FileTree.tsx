
import React from 'react';
import { FileCode, FileText, Image as ImageIcon, Box, Trash2, Table } from 'lucide-react';
import { VirtualFile, Language, UI_TEXT } from '../types';

interface FileTreeProps {
  files: VirtualFile[];
  onSelectFile: (file: VirtualFile) => void;
  onDeleteFile: (path: string) => void;
  selectedFilePath?: string;
  language: Language;
}

const getIcon = (fileName: string) => {
  if (fileName.endsWith('.tsx') || fileName.endsWith('.ts') || fileName.endsWith('.js') || fileName.endsWith('.jsx')) return <FileCode className="w-4 h-4 text-blue-400" />;
  if (fileName.endsWith('.css') || fileName.endsWith('.html')) return <FileCode className="w-4 h-4 text-orange-400" />;
  if (fileName.endsWith('.json')) return <FileCode className="w-4 h-4 text-yellow-400" />;
  if (fileName.endsWith('.csv')) return <Table className="w-4 h-4 text-green-400" />;
  if (fileName.match(/\.(jpg|jpeg|png|gif|svg)$/)) return <ImageIcon className="w-4 h-4 text-purple-400" />;
  if (fileName.endsWith('.zip')) return <Box className="w-4 h-4 text-red-400" />;
  return <FileText className="w-4 h-4 text-gray-400" />;
};

const FileTree: React.FC<FileTreeProps> = ({ files, onSelectFile, onDeleteFile, selectedFilePath, language }) => {
  const t = UI_TEXT[language];

  // Sort files: directories first, then alphabetical
  const sortedFiles = [...files].sort((a, b) => {
    return a.path.localeCompare(b.path);
  });

  return (
    <div className="flex flex-col h-full bg-gray-950 border-r border-gray-800 w-64 flex-shrink-0">
      <div className="p-4 border-b border-gray-800 flex justify-between items-center">
        <h2 className="text-sm font-semibold text-gray-300 tracking-wider uppercase">{t.workspace}</h2>
        <span className="text-xs text-gray-500">{files.length} {t.files}</span>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2">
        {files.length === 0 ? (
          <div className="text-center mt-10 text-gray-600 text-sm">
            <p>{t.noFiles}</p>
            <p className="mt-2 text-xs">{t.uploadHint}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {sortedFiles.map((file) => (
              <li key={file.path} className="group relative">
                <button
                  onClick={() => onSelectFile(file)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors truncate pr-10 text-left outline-none focus:bg-gray-800 ${
                    selectedFilePath === file.path
                      ? 'bg-blue-900/30 text-blue-200'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                  }`}
                  title={file.path}
                >
                  {getIcon(file.name)}
                  <span className="truncate">{file.path}</span>
                </button>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        // Direct delete without confirmation to avoid browser blocking issues
                        onDeleteFile(file.path);
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 text-gray-500 hover:text-red-400 rounded-md hover:bg-gray-800/80 transition-colors z-10 active:scale-90"
                    title="Delete file"
                >
                    <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default FileTree;
