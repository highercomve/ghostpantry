const MAX_DIMENSION = 1600;
const TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            "This photo could not be read. Try downloading it to your device first.",
          ),
        ),
      TIMEOUT_MS,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function encode(
  source: CanvasImageSource,
  width: number,
  height: number,
): string {
  if (!width || !height)
    throw new Error("This photo has no readable image data.");
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Photo processing is unavailable on this device.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL("image/jpeg", 0.85);
  if (!result.startsWith("data:image/jpeg;base64,"))
    throw new Error("Could not prepare this photo.");
  return result;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(
          new Error(
            "This image format cannot be opened. Choose a JPEG, PNG or WebP photo.",
          ),
        );
      image.src = url;
    }),
  );
}

export async function preparePhoto(file: File): Promise<string> {
  if (!file.size)
    throw new Error(
      "The selected photo is empty or unavailable. Download it and try again.",
    );
  if (file.size > 40 * 1024 * 1024)
    throw new Error("Choose a photo smaller than 40 MB.");
  if (file.type && !file.type.startsWith("image/"))
    throw new Error("Choose an image file.");
  if (typeof createImageBitmap === "function") {
    try {
      // Close even a bitmap that finishes decoding after the timeout.
      let expired = false;
      const decoding = createImageBitmap(file).then((bitmap) => {
        if (expired) bitmap.close();
        return bitmap;
      });
      try {
        const bitmap = await withTimeout(decoding);
        try {
          return encode(bitmap, bitmap.width, bitmap.height);
        } finally {
          bitmap.close();
        }
      } finally {
        expired = true;
      }
    } catch {
      /* Older WebViews need an HTMLImageElement instead. */
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    return encode(image, image.naturalWidth, image.naturalHeight);
  } catch {
    const dataUrl = await withTimeout(
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () =>
          reject(
            new Error(
              "Cannot read this photo. Try a photo stored on your device.",
            ),
          );
        reader.onabort = () =>
          reject(new Error("Photo reading was cancelled."));
        reader.onload = () =>
          typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(new Error("Cannot read this photo."));
        reader.readAsDataURL(file);
      }),
    );
    const image = await loadImage(dataUrl);
    return encode(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function captureVideo(video: HTMLVideoElement): string {
  return encode(video, video.videoWidth, video.videoHeight);
}
