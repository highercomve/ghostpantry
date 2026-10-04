import React, { useState, useRef, useEffect } from 'react';

interface CameraCaptureProps {
  onImageSelected: (base64Image: string) => void;
  selectedImage: string | null;
  onClear: () => void;
  disabled?: boolean;
}

export const CameraCapture: React.FC<CameraCaptureProps> = ({
  onImageSelected,
  selectedImage,
  onClear,
  disabled = false,
}) => {
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Stop camera stream on unmount
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  const startCamera = async (mode: 'environment' | 'user' = facingMode) => {
    try {
      setCameraError(null);
      stopCamera();

      // Check if mediaDevices supported
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError('Camera API is not supported in this environment. Please use file upload.');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setIsCameraActive(true);
    } catch (err: any) {
      console.warn('Could not start camera:', err);
      // Fallback: try without facingMode constraints
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        streamRef.current = fallbackStream;
        if (videoRef.current) {
          videoRef.current.srcObject = fallbackStream;
          videoRef.current.play();
        }
        setIsCameraActive(true);
      } catch (fallbackErr: any) {
        setCameraError('Camera access denied or unavailable. Please upload a photo instead.');
      }
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
  };

  const toggleCameraFacing = () => {
    const nextMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextMode);
    startCamera(nextMode);
  };

  const capturePhoto = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

    stopCamera();
    onImageSelected(dataUrl);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
  };

  const processFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file (JPEG, PNG, WebP).');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      if (result) {
        stopCamera();
        onImageSelected(result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  return (
    <div className="camera-capture-container">
      {/* Hidden file input for native camera / file picker */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        disabled={disabled}
      />

      {selectedImage ? (
        <div className="preview-card">
          <img src={selectedImage} alt="Captured food inventory" className="captured-preview-img" />
          <div className="preview-overlay-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClear}
              disabled={disabled}
            >
              🔄 Retake / Change Photo
            </button>
          </div>
        </div>
      ) : isCameraActive ? (
        <div className="video-live-card">
          <video ref={videoRef} autoPlay playsInline muted className="live-video-element" />
          <div className="camera-controls-bar">
            <button
              type="button"
              className="btn btn-icon"
              onClick={toggleCameraFacing}
              title="Switch camera"
              disabled={disabled}
            >
              🔄 Flip
            </button>
            <button
              type="button"
              className="btn btn-capture"
              onClick={capturePhoto}
              disabled={disabled}
            >
              📸 Take Picture
            </button>
            <button
              type="button"
              className="btn btn-icon"
              onClick={stopCamera}
              title="Close camera"
              disabled={disabled}
            >
              ✖ Close
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`dropzone-card ${isDragOver ? 'drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
        >
          <div className="dropzone-icon">📷</div>
          <h3>Take or Upload a Photo</h3>
          <p className="text-muted">
            Snap a picture of your fridge, pantry shelf, or food cabinets to recognize items and levels.
          </p>

          {cameraError && <div className="error-badge">{cameraError}</div>}

          <div className="dropzone-buttons">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => startCamera()}
              disabled={disabled}
            >
              📸 Open Camera
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
            >
              📁 Choose Photo / File
            </button>
          </div>
          <small className="drag-hint">or drag and drop a picture here</small>
        </div>
      )}
    </div>
  );
};
