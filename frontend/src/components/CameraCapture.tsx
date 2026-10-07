import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { captureVideo, preparePhoto } from "../lib/photos";

interface CameraCaptureProps {
  onImageSelected: (image: string) => void;
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
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(() => {
    if (cameraOpen && video.current && stream.current)
      video.current.srcObject = stream.current;
  }, [cameraOpen]);

  const closeCamera = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setCameraOpen(false);
  };
  const selectFile = async (file?: File) => {
    if (!file || disabled || busy.current) return;
    busy.current = true;
    setProcessing(true);
    setError(null);
    try {
      const image = await preparePhoto(file);
      if (mounted.current) onImageSelected(image);
    } catch (err) {
      if (mounted.current)
        setError(
          err instanceof Error
            ? err.message
            : "Could not open this photo. Please try another.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setProcessing(false);
    }
  };
  const handleInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    void selectFile(file);
  };
  const openCamera = async () => {
    setError(null);
    if (
      /Android|iPhone|iPad/i.test(navigator.userAgent) ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      cameraInput.current?.click();
      return;
    }
    busy.current = true;
    setProcessing(true);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (!mounted.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      setCameraOpen(true);
    } catch {
      setError(
        "Camera unavailable or permission denied. You can still choose a photo below.",
      );
    } finally {
      busy.current = false;
      if (mounted.current) setProcessing(false);
    }
  };
  const takePhoto = () => {
    try {
      if (!video.current) return;
      onImageSelected(captureVideo(video.current));
      closeCamera();
    } catch {
      setError("The camera is still starting. Wait a moment and try again.");
    }
  };

  return (
    <div className="camera-capture-box">
      <input
        aria-label="Take a photo"
        type="file"
        ref={cameraInput}
        onChange={handleInput}
        accept="image/*"
        capture="environment"
        hidden
        disabled={disabled || processing}
      />
      <input
        aria-label="Choose a photo"
        type="file"
        ref={galleryInput}
        onChange={handleInput}
        accept="image/*"
        hidden
        disabled={disabled || processing}
      />
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {processing ? (
        <div className="processing-photo-card" role="status">
          <span className="spinner" />
          <h3>Preparing your photo…</h3>
          <p className="text-muted">Making it ready for a closer look.</p>
        </div>
      ) : cameraOpen ? (
        <div className="preview-container">
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            className="preview-image"
          />
          <div className="preview-retake-bar">
            <button className="btn" onClick={closeCamera}>
              Cancel
            </button>
            <button className="btn primary" onClick={takePhoto}>
              <Icon name="camera" /> Take photo
            </button>
          </div>
        </div>
      ) : selectedImage ? (
        <div className="preview-container">
          <div className="preview-frame">
            <img
              src={selectedImage}
              alt="Your selected shelf photo"
              className="preview-image"
              onError={() => {
                setError(
                  "The photo preview could not load. Choose another photo.",
                );
                onClear();
              }}
            />
          </div>
          <div className="preview-retake-bar">
            <span className="photo-ready">
              <Icon name="check" size={16} /> Photo ready
            </span>
            <button
              className="btn btn-sm"
              onClick={onClear}
              disabled={disabled}
            >
              Change photo
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`capture-action-card ${dragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void selectFile(event.dataTransfer.files[0]);
          }}
        >
          <div className="capture-illustration" aria-hidden="true">
            <div className="shelf-line">
              <span className="jar tall" />
              <span className="jar" />
              <span className="bottle" />
            </div>
            <div className="frame-corner tl" />
            <div className="frame-corner tr" />
            <div className="frame-corner bl" />
            <div className="frame-corner br" />
          </div>
          <span className="eyebrow">A LITTLE SNAP. A CLEARER PANTRY.</span>
          <h3>What’s on your shelf?</h3>
          <p className="text-muted">
            Take a photo or bring one from your gallery.
            <br />
            We’ll help you see what you have.
          </p>
          <div className="capture-cta-buttons">
            <button
              className="btn primary btn-lg"
              onClick={openCamera}
              disabled={disabled}
            >
              <Icon name="camera" /> Take a photo
            </button>
            <button
              className="btn btn-lg"
              onClick={() => galleryInput.current?.click()}
              disabled={disabled}
            >
              <Icon name="upload" /> Choose a photo
            </button>
          </div>
          <span className="capture-hint">
            Or drop a photo here · JPEG, PNG, WebP · up to 40 MB
          </span>
        </div>
      )}
    </div>
  );
};
