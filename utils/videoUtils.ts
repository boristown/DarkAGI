

/**
 * Trims a video file client-side.
 * 
 * Note: This uses the browser's internal MediaRecorder API.
 * It essentially plays the video and records the segment, so it takes real-time to process.
 * The output format is typically 'video/webm' regardless of input.
 */
export const trimVideo = async (
  file: File | Uint8Array,
  mimeType: string,
  startTime: number,
  endTime: number
): Promise<Uint8Array> => {
  return new Promise((resolve, reject) => {
    // 1. Create a Blob from input
    const blob = file instanceof File ? file : new Blob([file], { type: mimeType });
    const videoUrl = URL.createObjectURL(blob);
    
    // 2. Create hidden video element
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true; // Required to play without user interaction context usually, but we captureStream
    video.crossOrigin = 'anonymous';
    
    // Workaround for some browsers: actually attach to DOM but hide it
    // This often ensures frame updates trigger correctly for captureStream
    video.style.position = 'absolute';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.opacity = '0';
    document.body.appendChild(video);

    let mediaRecorder: MediaRecorder | null = null;
    const chunks: Blob[] = [];

    const cleanup = () => {
        if (video.parentNode) document.body.removeChild(video);
        URL.revokeObjectURL(videoUrl);
    };

    video.onloadedmetadata = () => {
        if (!Number.isFinite(startTime) || startTime < 0) startTime = 0;
        if (!Number.isFinite(endTime) || endTime > video.duration) endTime = video.duration;
        
        if (startTime >= endTime) {
            cleanup();
            reject(new Error("Invalid trim parameters: Start time must be less than end time."));
            return;
        }

        // Seek to start
        video.currentTime = startTime;
    };

    video.onseeked = () => {
        if (video.currentTime >= endTime) return; // Ignore seek events if we are done

        if (!mediaRecorder) {
            // Start Recording
            try {
                // captureStream is experimental in some definitions but widely supported
                const stream = (video as any).captureStream ? (video as any).captureStream() : (video as any).mozCaptureStream();
                
                // Try to find a supported mime type
                const types = [
                    'video/webm;codecs=vp9',
                    'video/webm;codecs=vp8',
                    'video/webm',
                    'video/mp4' 
                ];
                const supportedType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';

                mediaRecorder = new MediaRecorder(stream, supportedType ? { mimeType: supportedType } : undefined);
                
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) {
                        chunks.push(e.data);
                    }
                };

                mediaRecorder.onstop = async () => {
                    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'video/webm' });
                    const buffer = await blob.arrayBuffer();
                    cleanup();
                    resolve(new Uint8Array(buffer));
                };

                mediaRecorder.start(100); // 100ms chunks
                video.play().catch(e => {
                    cleanup();
                    reject(new Error("Video playback failed: " + e.message));
                });
                
                // Monitor time to stop
                const checkTime = () => {
                    if (video.paused || video.ended) return;
                    
                    if (video.currentTime >= endTime) {
                        video.pause();
                        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                            mediaRecorder.requestData(); // Flush last chunk
                            mediaRecorder.stop();
                        }
                    } else {
                        requestAnimationFrame(checkTime);
                    }
                };
                requestAnimationFrame(checkTime);

            } catch (e: any) {
                cleanup();
                reject(new Error("MediaRecorder initialization failed: " + e.message));
            }
        }
    };

    video.onerror = () => {
        cleanup();
        reject(new Error("Error loading video source."));
    };
  });
};
