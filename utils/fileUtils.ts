import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { VirtualFile } from '../types';

export const parsePath = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  const fileName = parts.pop() || '';
  const dirPath = parts.join('/');
  return { fileName, dirPath, parts };
};

// Limit text reading to ~5MB to prevent browser crash during string manipulation
const MAX_TEXT_READ_SIZE = 5 * 1024 * 1024; 

export const readFileAsText = (file: File | Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_TEXT_READ_SIZE) {
        // Read only the head
        const slice = file.slice(0, 10000); // Read first 10KB
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string) + "\n... [Content truncated for memory safety. File too large.]");
        reader.onerror = reject;
        reader.readAsText(slice);
        return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
};

export const readFileAsArrayBuffer = (file: File | Blob): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};

export const uint8ArrayToBase64 = (buffer: Uint8Array): string => {
  let binary = '';
  const len = buffer.byteLength;
  const chunkSize = 0x8000; // 32KB chunks to prevent stack overflow
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = buffer.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return window.btoa(binary);
};

export const base64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

export const isTextFile = (fileName: string): boolean => {
  return /\.(txt|md|json|js|ts|tsx|jsx|html|css|py|c|cpp|h|java|xml|yml|yaml|ini|env|csv|log|sh|bat)$/i.test(fileName);
};

export const isGeminiSupportedMimeType = (mimeType: string): boolean => {
  const supported = [
    'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
    'application/pdf',
    'audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
    'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp'
  ];
  return supported.includes(mimeType);
};

export const getMimeType = (fileName: string): string => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'webp': 'image/webp',
        'pdf': 'application/pdf',
        'mp3': 'audio/mp3',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'mov': 'video/mov',
        'avi': 'video/avi',
        'mpeg': 'video/mpeg',
        'mpg': 'video/mpg',
        '3gp': 'video/3gpp',
        'wmv': 'video/wmv',
        'flv': 'video/x-flv',
        'json': 'application/json',
        'txt': 'text/plain',
        'js': 'text/javascript',
        'ts': 'text/plain',
        'tsx': 'text/plain',
        'html': 'text/html',
        'css': 'text/css',
        'csv': 'text/csv'
    };
    return mimeMap[ext || ''] || 'application/octet-stream';
};

/**
 * Splits a large PDF file into smaller chunks.
 * @param file Source file
 * @param maxChunkSizeMB Target chunk size in MB (default 10MB)
 */
export const splitLargePdf = async (file: File, maxChunkSizeMB: number = 10): Promise<File[]> => {
  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const totalPages = pdfDoc.getPageCount();
    
    // Estimate pages per chunk. 
    // Heuristic: Average page size.
    const avgPageSize = file.size / totalPages;
    const targetBytes = maxChunkSizeMB * 1024 * 1024;
    const pagesPerChunk = Math.max(1, Math.floor(targetBytes / avgPageSize));
    
    if (file.size <= targetBytes) {
      return [file]; // No need to split
    }

    const chunks: File[] = [];
    const baseName = file.name.replace(/\.pdf$/i, '');

    for (let i = 0; i < totalPages; i += pagesPerChunk) {
      const subDoc = await PDFDocument.create();
      const endPage = Math.min(i + pagesPerChunk, totalPages);
      
      // Create array of page indices to copy
      const pageIndices: number[] = [];
      for(let j = i; j < endPage; j++) {
          pageIndices.push(j);
      }
      
      const copiedPages = await subDoc.copyPages(pdfDoc, pageIndices);
      copiedPages.forEach(page => subDoc.addPage(page));
      
      const subPdfBytes = await subDoc.save();
      const partNum = Math.floor(i / pagesPerChunk) + 1;
      const chunkName = `${baseName}_part${partNum}.pdf`;
      
      chunks.push(new File([subPdfBytes], chunkName, { type: 'application/pdf' }));
      
      // Allow UI to breathe if this takes long
      await new Promise(r => setTimeout(r, 10));
    }
    
    return chunks;
  } catch (error) {
    console.error("Failed to split PDF:", error);
    // Fallback: return original file if splitting fails (e.g. encrypted)
    return [file];
  }
};

export const handleFileUpload = async (files: FileList | File[]): Promise<VirtualFile[]> => {
  const virtualFiles: VirtualFile[] = [];
  const fileArray = files instanceof FileList ? Array.from(files) : files;

  for (const file of fileArray) {
    if (file.name.toLowerCase().endsWith('.pdf') && file.size > 10 * 1024 * 1024) {
       // Auto-split large PDFs > 10MB
       const chunks = await splitLargePdf(file, 10); // 10MB chunks
       
       for (const chunk of chunks) {
         virtualFiles.push({
            path: chunk.name,
            name: chunk.name,
            content: chunk,
            size: chunk.size,
            type: 'file',
            lastModified: chunk.lastModified,
            mimeType: 'application/pdf'
         });
       }
    } else if (file.name.endsWith('.zip')) {
      // For ZIPs, we MUST read them to unzip, but we should be careful with huge zips
      // NOTE: JSZip loads everything into memory. 
      // Ideally, for >100MB zips, we should reject or stream, but strict requirement says "handle"
      // We will try to read, but catch memory errors.
      try {
          const arrayBuffer = await readFileAsArrayBuffer(file);
          const zip = await JSZip.loadAsync(arrayBuffer);
          
          for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
            const entry = zipEntry as any;
            if (!entry.dir) {
               const isText = isTextFile(relativePath);
               // Decompressing huge files inside zip will still crash. 
               // Only load content if < 10MB
               let content: string | Uint8Array | File = "File too large to preload from zip";
               
               // We cannot easily turn a zip entry back into a File object without reading it into memory blobs first.
               // So we stick to buffer but skip huge ones.
               const size = entry._data.uncompressedSize || 0;
               
               if (size < 10 * 1024 * 1024) {
                   if (isText) {
                     content = await entry.async('string');
                   } else {
                     content = await entry.async('uint8array');
                   }
               }
               
               virtualFiles.push({
                 path: relativePath,
                 name: relativePath.split('/').pop() || relativePath,
                 content,
                 size: size,
                 type: 'file',
                 lastModified: entry.date.getTime(),
                 mimeType: getMimeType(relativePath)
               });
            }
          }
      } catch (e) {
          console.error("Failed to process zip", e);
          // Fallback: treat zip as a single binary file
          virtualFiles.push({
            path: file.name,
            name: file.name,
            content: file, // Store Raw File
            size: file.size,
            type: 'file',
            lastModified: file.lastModified,
            mimeType: file.type || 'application/zip'
          });
      }
    } else {
      // For normal files, DO NOT READ CONTENT YET.
      // Store the File object reference.
      virtualFiles.push({
        path: file.name,
        name: file.name,
        content: file, // Store Raw File
        size: file.size,
        type: 'file',
        lastModified: file.lastModified,
        mimeType: file.type || getMimeType(file.name)
      });
    }
  }
  return virtualFiles;
};

// Helper to actually get content when the Agent asks for it
export const resolveFileContent = async (vFile: VirtualFile): Promise<string | Uint8Array> => {
    if (vFile.content instanceof File) {
        if (isTextFile(vFile.name)) {
            return await readFileAsText(vFile.content);
        } else {
            const ab = await readFileAsArrayBuffer(vFile.content);
            return new Uint8Array(ab);
        }
    }
    return vFile.content as string | Uint8Array;
};

export const getVideoMetadata = (file: File | Blob): Promise<{ duration: number, width: number, height: number }> => {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight
      });
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load video metadata"));
    };
    video.src = url;
  });
};

export const generateFileTreeContext = (files: VirtualFile[]): string => {
  if (files.length === 0) return '[System: No files currently in the virtual workspace.]';
  
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  
  let output = "[[ VIRTUAL FILE SYSTEM STATE ]]\n";
  output += "The following files are available for you to read, edit, or process:\n";
  sorted.forEach(f => {
    const sizeStr = f.size > 1024 * 1024 ? `${(f.size / (1024*1024)).toFixed(2)} MB` : `${f.size} bytes`;
    output += `- ${f.path} (Type: ${f.mimeType || 'unknown'}, Size: ${sizeStr})\n`;
  });

  output += "\nInstructions: Files are NOT automatically read. To see content, you MUST use the `read` action. If the file is binary or large (>1MB), the system will attach it. Do NOT try to read >10MB files as text.";

  return output;
};